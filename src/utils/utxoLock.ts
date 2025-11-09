import { log, error } from "./logger";

/**
 * UTXO Locking Service
 *
 * Prevents concurrent operations from using the same UTXOs,
 * which would cause double-spend transaction failures.
 */

interface LockedUtxo {
	commitment: string;
	lockedAt: number;
	operation: string;
}

class UtxoLockService {
	private locks: Map<string, LockedUtxo> = new Map();
	private lockTimeout: number = 300000; // 5 minutes default

	constructor(lockTimeoutMs: number = 300000) {
		this.lockTimeout = lockTimeoutMs;

		// Clean up expired locks every minute
		setInterval(() => this.cleanupExpiredLocks(), 60000);
	}

	/**
	 * Try to acquire locks on multiple UTXOs
	 * Returns true if all locks acquired, false otherwise
	 */
	tryLock(commitments: string[], operation: string): boolean {
		// Check if any are already locked
		const alreadyLocked = commitments.filter((c) =>
			this.locks.has(c),
		);

		if (alreadyLocked.length > 0) {
			error(
				`Cannot lock UTXOs - ${
					alreadyLocked.length
				} already locked: ${alreadyLocked
					.slice(0, 3)
					.join(", ")}${
					alreadyLocked.length > 3 ? "..." : ""
				}`,
			);
			return false;
		}

		// Acquire all locks atomically
		const now = Date.now();
		for (const commitment of commitments) {
			this.locks.set(commitment, {
				commitment,
				lockedAt: now,
				operation,
			});
		}

		log(`🔒 Locked ${commitments.length} UTXOs for ${operation}`);
		return true;
	}

	/**
	 * Try to acquire lock with retry
	 */
	async tryLockWithRetry(
		commitments: string[],
		operation: string,
		maxRetries: number = 3,
		retryDelayMs: number = 1000,
	): Promise<boolean> {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (this.tryLock(commitments, operation)) {
				return true;
			}

			if (attempt < maxRetries) {
				log(
					`Lock acquisition failed, retrying in ${retryDelayMs}ms... (${
						attempt + 1
					}/${maxRetries})`,
				);
				await new Promise((resolve) =>
					setTimeout(resolve, retryDelayMs),
				);
			}
		}

		return false;
	}

	/**
	 * Release locks on UTXOs
	 */
	unlock(commitments: string[]): void {
		let unlockedCount = 0;
		for (const commitment of commitments) {
			if (this.locks.delete(commitment)) {
				unlockedCount++;
			}
		}

		if (unlockedCount > 0) {
			log(`🔓 Unlocked ${unlockedCount} UTXOs`);
		}
	}

	/**
	 * Check if UTXO is locked
	 */
	isLocked(commitment: string): boolean {
		return this.locks.has(commitment);
	}

	/**
	 * Get lock info
	 */
	getLockInfo(commitment: string): LockedUtxo | null {
		return this.locks.get(commitment) || null;
	}

	/**
	 * Clean up expired locks
	 */
	private cleanupExpiredLocks(): void {
		const now = Date.now();
		const expired: string[] = [];

		for (const [commitment, lock] of this.locks.entries()) {
			if (now - lock.lockedAt > this.lockTimeout) {
				expired.push(commitment);
			}
		}

		if (expired.length > 0) {
			log(
				`🧹 Cleaning up ${expired.length} expired UTXO locks`,
			);
			for (const commitment of expired) {
				this.locks.delete(commitment);
			}
		}
	}

	/**
	 * Force unlock all (use with caution)
	 */
	unlockAll(): void {
		const count = this.locks.size;
		this.locks.clear();
		if (count > 0) {
			log(`🔓 Force unlocked all ${count} UTXOs`);
		}
	}

	/**
	 * Get statistics
	 */
	getStats(): { totalLocked: number; oldestLockAge: number | null } {
		if (this.locks.size === 0) {
			return { totalLocked: 0, oldestLockAge: null };
		}

		const now = Date.now();
		let oldestLockAge = 0;

		for (const lock of this.locks.values()) {
			const age = now - lock.lockedAt;
			if (age > oldestLockAge) {
				oldestLockAge = age;
			}
		}

		return {
			totalLocked: this.locks.size,
			oldestLockAge,
		};
	}
}

// Global singleton instance
let globalUtxoLockService: UtxoLockService | null = null;

/**
 * Get or create the global UTXO lock service
 */
export function getUtxoLockService(lockTimeoutMs?: number): UtxoLockService {
	if (!globalUtxoLockService) {
		globalUtxoLockService = new UtxoLockService(lockTimeoutMs);
	}
	return globalUtxoLockService;
}

/**
 * Helper function to execute operation with UTXO locks
 */
export async function withUtxoLocks<T>(
	commitments: string[],
	operation: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockService = getUtxoLockService();

	// Try to acquire locks with retry
	const locked = await lockService.tryLockWithRetry(
		commitments,
		operation,
	);

	if (!locked) {
		throw new Error(
			`Failed to acquire locks on ${commitments.length} UTXOs after retries. Another operation may be using these UTXOs.`,
		);
	}

	try {
		// Execute the operation
		return await fn();
	} finally {
		// Always unlock, even if operation fails
		lockService.unlock(commitments);
	}
}
