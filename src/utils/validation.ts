import { PublicKey, Connection } from "@solana/web3.js";
import BN from "bn.js";
import { error as error, log } from "./logger";

/**
 * Validation utilities for SDK operations
 */

// Solana transaction size limit (1232 bytes for regular transactions)
const MAX_TRANSACTION_SIZE = 1700;
const ESTIMATED_BASE_TRANSACTION_SIZE = 300; // Base overhead
const ESTIMATED_PROOF_SIZE = 800; // ZK proof size
const ESTIMATED_SIGNATURE_SIZE = 64;
const ESTIMATED_ACCOUNT_SIZE = 32;

// Amount limits
const MAX_LAMPORTS = new BN("18446744073709551615"); // u64 max
const MIN_RENT_EXEMPT_BALANCE = 890880; // Minimum SOL for rent exemption

/**
 * Validation error class with detailed context
 */
export class ValidationError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly details?: any,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * Validate deposit amount
 */
export function validateDepositAmount(
	amountInSol: number,
	userBalance: number,
	feeAmount: number,
): void {
	// Check if amount is positive
	if (amountInSol <= 0) {
		throw new ValidationError(
			"Deposit amount must be greater than zero",
			"INVALID_AMOUNT",
			{ amount: amountInSol },
		);
	}

	// Check if amount is a valid number
	if (!Number.isFinite(amountInSol)) {
		throw new ValidationError(
			"Deposit amount must be a valid number",
			"INVALID_AMOUNT",
			{ amount: amountInSol },
		);
	}

	const amountInLamports = amountInSol * 1e9;

	// Check for overflow
	if (amountInLamports > Number.MAX_SAFE_INTEGER) {
		throw new ValidationError(
			"Deposit amount is too large",
			"AMOUNT_OVERFLOW",
			{
				amount: amountInSol,
				maxSol: Number.MAX_SAFE_INTEGER / 1e9,
			},
		);
	}

	const amountBN = new BN(amountInLamports);
	if (amountBN.gt(MAX_LAMPORTS)) {
		throw new ValidationError(
			"Deposit amount exceeds maximum allowed value",
			"AMOUNT_OVERFLOW",
			{
				amount: amountInSol,
				maxLamports: MAX_LAMPORTS.toString(),
			},
		);
	}

	// Check if user has sufficient balance (including fees)
	const totalRequired = amountInLamports + feeAmount;
	if (userBalance < totalRequired) {
		throw new ValidationError(
			`Insufficient balance. Required: ${
				totalRequired / 1e9
			} SOL (${amountInSol} + ${
				feeAmount / 1e9
			} fee), Available: ${userBalance / 1e9} SOL`,
			"INSUFFICIENT_BALANCE",
			{
				required: totalRequired,
				available: userBalance,
				amount: amountInLamports,
				fee: feeAmount,
			},
		);
	}

	// Check if user would have enough left for rent
	const remaining = userBalance - totalRequired;
	if (remaining < MIN_RENT_EXEMPT_BALANCE && remaining > 0) {
		error(
			`⚠️  Warning: After deposit, remaining balance (${
				remaining / 1e9
			} SOL) is below rent-exempt minimum (${
				MIN_RENT_EXEMPT_BALANCE / 1e9
			} SOL)`,
		);
	}
}

/**
 * Validate withdrawal amount
 */
export function validateWithdrawalAmount(
	amountInSol: number,
	availableBalance: BN,
	feeAmount: number,
): { isPartial: boolean; adjustedAmount: number } {
	// Check if amount is positive
	if (amountInSol <= 0) {
		throw new ValidationError(
			"Withdrawal amount must be greater than zero",
			"INVALID_AMOUNT",
			{ amount: amountInSol },
		);
	}

	// Check if amount is a valid number
	if (!Number.isFinite(amountInSol)) {
		throw new ValidationError(
			"Withdrawal amount must be a valid number",
			"INVALID_AMOUNT",
			{ amount: amountInSol },
		);
	}

	const amountInLamports = Math.floor(amountInSol * 1e9);

	// Check for overflow
	if (amountInLamports > Number.MAX_SAFE_INTEGER) {
		throw new ValidationError(
			"Withdrawal amount is too large",
			"AMOUNT_OVERFLOW",
			{ amount: amountInSol },
		);
	}

	const requestedBN = new BN(amountInLamports);
	const feeBN = new BN(feeAmount);
	const totalRequiredBN = requestedBN.add(feeBN);

	// Check if sufficient balance
	if (availableBalance.lt(totalRequiredBN)) {
		throw new ValidationError(
			`Insufficient balance for withdrawal. Required: ${
				totalRequiredBN.toNumber() / 1e9
			} SOL (${amountInSol} + ${
				feeAmount / 1e9
			} fee), Available: ${
				availableBalance.toNumber() / 1e9
			} SOL`,
			"INSUFFICIENT_BALANCE",
			{
				required: totalRequiredBN.toNumber(),
				available: availableBalance.toNumber(),
				amount: amountInLamports,
				fee: feeAmount,
			},
		);
	}

	return { isPartial: false, adjustedAmount: amountInSol };
}

/**
 * Validate SPL token amount
 */
export function validateSplAmount(amount: number, decimals: number = 9): void {
	if (amount <= 0) {
		throw new ValidationError(
			"SPL token amount must be greater than zero",
			"INVALID_AMOUNT",
			{ amount },
		);
	}

	if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
		throw new ValidationError(
			"SPL token amount must be a valid integer (in base units)",
			"INVALID_AMOUNT",
			{ amount },
		);
	}

	// Check for overflow
	if (amount > Number.MAX_SAFE_INTEGER) {
		throw new ValidationError(
			"SPL token amount is too large",
			"AMOUNT_OVERFLOW",
			{ amount },
		);
	}

	const amountBN = new BN(amount);
	if (amountBN.gt(MAX_LAMPORTS)) {
		throw new ValidationError(
			"SPL token amount exceeds maximum allowed value",
			"AMOUNT_OVERFLOW",
			{ amount, maxValue: MAX_LAMPORTS.toString() },
		);
	}
}

/**
 * Validate public key
 */
export function validatePublicKey(
	key: string | PublicKey,
	fieldName: string = "address",
): PublicKey {
	try {
		return typeof key === "string" ? new PublicKey(key) : key;
	} catch (error) {
		throw new ValidationError(
			`Invalid ${fieldName}: ${key}`,
			"INVALID_PUBLIC_KEY",
			{ fieldName, value: key },
		);
	}
}

/**
 * Check if recipient has token account for SPL withdrawals
 */
export async function validateRecipientTokenAccount(
	connection: Connection,
	recipientAddress: PublicKey,
	mintAddress: PublicKey,
): Promise<{ exists: boolean; address?: PublicKey; needsCreation: boolean }> {
	try {
		// Derive associated token account address
		const TOKEN_PROGRAM_ID = new PublicKey(
			"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		);
		const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
			"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
		);

		// Manually derive ATA address
		const [ataAddress] = PublicKey.findProgramAddressSync(
			[
				recipientAddress.toBuffer(),
				TOKEN_PROGRAM_ID.toBuffer(),
				mintAddress.toBuffer(),
			],
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// Check if account exists
		const accountInfo = await connection.getAccountInfo(ataAddress);

		if (accountInfo) {
			log(
				`✓ Recipient token account exists: ${ataAddress.toString()}`,
			);
			return {
				exists: true,
				address: ataAddress,
				needsCreation: false,
			};
		} else {
			error(
				`⚠️  Recipient does not have a token account for this mint. Account will need to be created (requires ~0.002 SOL rent).`,
			);
			return {
				exists: false,
				address: ataAddress,
				needsCreation: true,
			};
		}
	} catch (err) {
		error(`Error checking recipient token account: ${err}`);
		// Return as needs creation to be safe
		return { exists: false, needsCreation: true };
	}
}

/**
 * Estimate transaction size
 */
export function estimateTransactionSize(params: {
	numInputs: number;
	numOutputs: number;
	hasProof: boolean;
	numAdditionalAccounts?: number;
}): number {
	let size = ESTIMATED_BASE_TRANSACTION_SIZE;

	// Add proof size
	if (params.hasProof) {
		size += ESTIMATED_PROOF_SIZE;
	}

	// Add signature
	size += ESTIMATED_SIGNATURE_SIZE;

	// Add account metas (32 bytes per account)
	const accountCount =
		params.numInputs * 2 + // nullifier PDAs for inputs
		params.numOutputs +
		5 + // tree, config, recipient, fee recipient, system program
		(params.numAdditionalAccounts || 0);

	size += accountCount * ESTIMATED_ACCOUNT_SIZE;

	return size;
}

/**
 * Validate transaction won't exceed size limit
 */
export function validateTransactionSize(params: {
	numInputs: number;
	numOutputs: number;
	hasProof: boolean;
	numAdditionalAccounts?: number;
}): void {
	const estimatedSize = estimateTransactionSize(params);

	if (estimatedSize > MAX_TRANSACTION_SIZE) {
		throw new ValidationError(
			`Transaction size (${estimatedSize} bytes) would exceed Solana limit (${MAX_TRANSACTION_SIZE} bytes). Try reducing the number of inputs.`,
			"TRANSACTION_TOO_LARGE",
			{
				estimatedSize,
				maxSize: MAX_TRANSACTION_SIZE,
				...params,
			},
		);
	}

	log(
		`✓ Transaction size estimate: ${estimatedSize} bytes (limit: ${MAX_TRANSACTION_SIZE})`,
	);
}

/**
 * Validate delay minutes for delayed withdrawals
 */
export function validateDelayMinutes(delayMinutes?: number): void {
	if (delayMinutes === undefined || delayMinutes === 0) {
		return; // Immediate withdrawal, no validation needed
	}

	if (delayMinutes < 0) {
		throw new ValidationError(
			"Delay minutes cannot be negative",
			"INVALID_DELAY",
			{ delayMinutes },
		);
	}

	if (!Number.isInteger(delayMinutes)) {
		throw new ValidationError(
			"Delay minutes must be an integer",
			"INVALID_DELAY",
			{ delayMinutes },
		);
	}

	const MAX_DELAY_MINUTES = 10080; // 7 days
	if (delayMinutes > MAX_DELAY_MINUTES) {
		throw new ValidationError(
			`Delay cannot exceed ${MAX_DELAY_MINUTES} minutes (7 days)`,
			"INVALID_DELAY",
			{ delayMinutes, maxDelay: MAX_DELAY_MINUTES },
		);
	}
}

/**
 * Parse on-chain error to detect specific failure reasons
 */
export function parseTransactionError(error: any): {
	isRootMismatch: boolean;
	isInsufficientFunds: boolean;
	isNullifierAlreadyUsed: boolean;
	message: string;
} {
	const errorString = error?.message || error?.toString() || "";
	const errorLower = errorString.toLowerCase();

	return {
		isRootMismatch:
			errorLower.includes("invalid root") ||
			errorLower.includes("root mismatch") ||
			errorLower.includes("merkle root"),
		isInsufficientFunds:
			errorLower.includes("insufficient funds") ||
			errorLower.includes("insufficient lamports") ||
			errorLower.includes("account not found"),
		isNullifierAlreadyUsed:
			errorLower.includes("nullifier") &&
			(errorLower.includes("already") ||
				errorLower.includes("used") ||
				errorLower.includes("exists")),
		message: errorString,
	};
}
