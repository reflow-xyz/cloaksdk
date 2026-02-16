import { describe, expect, it } from "vitest";
import { WITHDRAW_FEE_RATE } from "./constants";
import {
	DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS,
	computeMaxTransferableLamports,
	computeVariableFeeLamports,
} from "./max-transferable";

describe("computeMaxTransferableLamports", () => {
	it("returns zero when fixed withdrawal costs exceed balance", () => {
		const result = computeMaxTransferableLamports({
			availableLamports: 1_000_000n,
			numberOfWithdrawals: 1,
			withdrawFeeRatePercent: WITHDRAW_FEE_RATE,
			fixedCostPerWithdrawalLamports:
				DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS,
		});

		expect(result.maxTransferableLamports).toBe(0n);
		expect(result.totalFixedCostLamports).toBe(
			DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS,
		);
	});

	it("finds an exact max amount that fits variable+fixed fees", () => {
		const result = computeMaxTransferableLamports({
			availableLamports: 1_000_000_000n, // 1 SOL
			numberOfWithdrawals: 2,
			withdrawFeeRatePercent: 0.3,
			fixedCostPerWithdrawalLamports:
				1_907_040n, // 2 * 953_520
		});

		const budget =
			result.availableLamports - result.totalFixedCostLamports;
		const feeAtMax = computeVariableFeeLamports(
			result.maxTransferableLamports,
			0.3,
		);
		expect(result.maxTransferableLamports + feeAtMax <= budget).toBe(
			true,
		);

		const next = result.maxTransferableLamports + 1n;
		const feeAtNext = computeVariableFeeLamports(next, 0.3);
		expect(next + feeAtNext <= budget).toBe(false);
	});

	it("supports zero variable fee rate", () => {
		const result = computeMaxTransferableLamports({
			availableLamports: 500n,
			numberOfWithdrawals: 2,
			withdrawFeeRatePercent: 0,
			fixedCostPerWithdrawalLamports: 100n,
		});
		expect(result.maxTransferableLamports).toBe(300n);
		expect(result.variableFeeAtMaxLamports).toBe(0n);
		expect(result.totalFeeAtMaxLamports).toBe(200n);
	});
});
