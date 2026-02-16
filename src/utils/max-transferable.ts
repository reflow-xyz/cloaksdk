import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { WITHDRAW_FEE_RATE } from "./constants";

export const DEFAULT_NULLIFIER_RENT_LAMPORTS = 953_520n;
export const DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS =
	DEFAULT_NULLIFIER_RENT_LAMPORTS * 2n;

const ONE_MILLION = 1_000_000n;

export interface MaxTransferableComputationInput {
	availableLamports: bigint;
	numberOfWithdrawals: number;
	withdrawFeeRatePercent?: number;
	fixedCostPerWithdrawalLamports?: bigint;
}

export interface MaxTransferableComputationResult {
	availableLamports: bigint;
	numberOfWithdrawals: number;
	withdrawFeeRatePercent: number;
	fixedCostPerWithdrawalLamports: bigint;
	totalFixedCostLamports: bigint;
	maxTransferableLamports: bigint;
	variableFeeAtMaxLamports: bigint;
	totalFeeAtMaxLamports: bigint;
}

export function feeRatePercentToPpm(feeRatePercent: number): bigint {
	if (!Number.isFinite(feeRatePercent) || feeRatePercent < 0) {
		throw new Error("withdrawFeeRatePercent must be a non-negative number");
	}
	return BigInt(Math.round(feeRatePercent * 10_000));
}

export function computeVariableFeeLamports(
	amountLamports: bigint,
	feeRatePercent: number,
): bigint {
	const feeRatePpm = feeRatePercentToPpm(feeRatePercent);
	return (amountLamports * feeRatePpm) / ONE_MILLION;
}

export function computeMaxTransferableLamports(
	input: MaxTransferableComputationInput,
): MaxTransferableComputationResult {
	const numberOfWithdrawals = input.numberOfWithdrawals;
	if (!Number.isInteger(numberOfWithdrawals) || numberOfWithdrawals <= 0) {
		throw new Error("numberOfWithdrawals must be a positive integer");
	}

	const availableLamports = input.availableLamports;
	if (availableLamports < 0n) {
		throw new Error("availableLamports cannot be negative");
	}

	const withdrawFeeRatePercent =
		input.withdrawFeeRatePercent ?? WITHDRAW_FEE_RATE;
	const fixedCostPerWithdrawalLamports =
		input.fixedCostPerWithdrawalLamports ??
		DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS;
	if (fixedCostPerWithdrawalLamports < 0n) {
		throw new Error(
			"fixedCostPerWithdrawalLamports cannot be negative",
		);
	}

	const totalFixedCostLamports =
		fixedCostPerWithdrawalLamports * BigInt(numberOfWithdrawals);
	if (availableLamports <= totalFixedCostLamports) {
		return {
			availableLamports,
			numberOfWithdrawals,
			withdrawFeeRatePercent,
			fixedCostPerWithdrawalLamports,
			totalFixedCostLamports,
			maxTransferableLamports: 0n,
			variableFeeAtMaxLamports: 0n,
			totalFeeAtMaxLamports: totalFixedCostLamports,
		};
	}

	const transferableBudgetLamports =
		availableLamports - totalFixedCostLamports;
	const feeRatePpm = feeRatePercentToPpm(withdrawFeeRatePercent);

	let candidate =
		(transferableBudgetLamports * ONE_MILLION) /
		(ONE_MILLION + feeRatePpm);
	if (candidate < 0n) {
		candidate = 0n;
	}

	// Tighten to exact max under integer floor-fee arithmetic.
	const fits = (value: bigint): boolean => {
		const variableFee = computeVariableFeeLamports(
			value,
			withdrawFeeRatePercent,
		);
		return value + variableFee <= transferableBudgetLamports;
	};
	while (candidate > 0n && !fits(candidate)) {
		candidate -= 1n;
	}
	while (fits(candidate + 1n)) {
		candidate += 1n;
	}

	const variableFeeAtMaxLamports = computeVariableFeeLamports(
		candidate,
		withdrawFeeRatePercent,
	);
	const totalFeeAtMaxLamports =
		variableFeeAtMaxLamports + totalFixedCostLamports;

	return {
		availableLamports,
		numberOfWithdrawals,
		withdrawFeeRatePercent,
		fixedCostPerWithdrawalLamports,
		totalFixedCostLamports,
		maxTransferableLamports: candidate,
		variableFeeAtMaxLamports,
		totalFeeAtMaxLamports,
	};
}

export function solToLamportsNonNegative(amountSol: number): bigint {
	if (!Number.isFinite(amountSol) || amountSol < 0) {
		throw new Error("amount must be a non-negative finite number");
	}
	return BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
}
