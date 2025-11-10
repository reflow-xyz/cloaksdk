/**
 * BATCH DEPOSIT - Multiple deposits for denomination breakdowns
 *
 * Optimized batch deposit with single-popup signing for denomination-based deposits.
 * Allows users to deposit amounts that need to be broken down into standard denominations
 * (100, 10, 1, 0.1, 0.01, 0.001 SOL) with only one wallet signature prompt.
 */

import type { VersionedTransaction } from "@solana/web3.js";
import { log, warn } from "./logger";

export interface BatchDepositPlan {
	deposits: {
		amount: number; // Amount to deposit in this transaction (in base units: lamports or token amount)
	}[];
	totalAmount: number;
	totalDeposits: number;
}

/**
 * Calculate denomination breakdown for a given amount
 * Breaks down amounts into standard pool denominations for maximum privacy
 */
function calculateDenominations(amount: number): number[] {
	const DENOMS = [100, 10, 1, 0.1, 0.01, 0.001];
	const result: number[] = [];
	let remaining = amount;

	for (const denom of DENOMS) {
		while (remaining >= denom - 0.0001) {
			// Account for floating point precision
			result.push(denom);
			remaining -= denom;
			remaining = parseFloat(remaining.toFixed(9));
		}
	}

	return result;
}

/**
 * Calculate how to split a large deposit into multiple denomination-based transactions
 * Returns null if amount is too small for any denomination
 */
export function planBatchDeposits(
	totalAmount: number, // in SOL (will be converted to lamports internally)
): BatchDepositPlan | null {
	log(`[SDK] Planning batch deposits for ${totalAmount} SOL`);

	const denominations = calculateDenominations(totalAmount);

	if (denominations.length === 0) {
		warn(`[SDK] Amount ${totalAmount} too small for any denomination`);
		return null;
	}

	log(`[SDK] Calculated ${denominations.length} deposit transactions`);
	log(`[SDK] Denominations: ${denominations.join(", ")}`);

	const deposits = denominations.map((amount) => ({
		amount,
	}));

	return {
		deposits,
		totalAmount: denominations.reduce((sum, amt) => sum + amt, 0),
		totalDeposits: denominations.length,
	};
}

/**
 * Preview batch deposit operations without executing them
 * Returns breakdown information for UI display
 */
export function previewBatchDeposit(
	totalAmount: number,
): {
	numTransactions: number;
	totalAmount: number;
	breakdown: { amount: number; count: number }[];
	estimatedTime: number; // seconds
} | null {
	const plan = planBatchDeposits(totalAmount);

	if (!plan) {
		return null;
	}

	// Group denominations by amount for UI display
	const denominationCounts = new Map<number, number>();
	plan.deposits.forEach(({ amount }) => {
		denominationCounts.set(amount, (denominationCounts.get(amount) || 0) + 1);
	});

	const breakdown = Array.from(denominationCounts.entries()).map(
		([amount, count]) => ({
			amount,
			count,
		}),
	);

	// Estimated time: 22s per deposit + 30s for final UTXO refresh
	const estimatedTime = plan.totalDeposits * 22 + 30;

	return {
		numTransactions: plan.totalDeposits,
		totalAmount: plan.totalAmount,
		breakdown,
		estimatedTime,
	};
}

/**
 * Calculate SPL token denomination breakdown
 * Similar to SOL but works with token-specific decimal places
 */
function calculateSplDenominations(
	amountInBaseUnits: number,
	decimals: number,
): number[] {
	// Convert to token units for denomination calculation
	const amountInTokens = amountInBaseUnits / Math.pow(10, decimals);

	// Use same denomination logic as SOL
	const tokenDenominations = calculateDenominations(amountInTokens);

	// Convert back to base units
	return tokenDenominations.map((amt) =>
		Math.floor(amt * Math.pow(10, decimals)),
	);
}

/**
 * Plan batch SPL token deposits
 */
export function planBatchSplDeposits(
	amountInBaseUnits: number,
	decimals: number,
): BatchDepositPlan | null {
	const denominations = calculateSplDenominations(amountInBaseUnits, decimals);

	if (denominations.length === 0) {
		return null;
	}

	const deposits = denominations.map((amount) => ({
		amount,
	}));

	return {
		deposits,
		totalAmount: denominations.reduce((sum, amt) => sum + amt, 0),
		totalDeposits: denominations.length,
	};
}

/**
 * Preview batch SPL deposit operations
 */
export function previewBatchSplDeposit(
	amountInBaseUnits: number,
	decimals: number,
): {
	numTransactions: number;
	totalAmount: number;
	breakdown: { amount: number; count: number }[];
	estimatedTime: number;
} | null {
	const plan = planBatchSplDeposits(amountInBaseUnits, decimals);

	if (!plan) {
		return null;
	}

	// Group denominations by amount for UI display
	const denominationCounts = new Map<number, number>();
	plan.deposits.forEach(({ amount }) => {
		denominationCounts.set(amount, (denominationCounts.get(amount) || 0) + 1);
	});

	const breakdown = Array.from(denominationCounts.entries()).map(
		([amount, count]) => ({
			amount,
			count,
		}),
	);

	const estimatedTime = plan.totalDeposits * 22 + 30;

	return {
		numTransactions: plan.totalDeposits,
		totalAmount: plan.totalAmount,
		breakdown,
		estimatedTime,
	};
}