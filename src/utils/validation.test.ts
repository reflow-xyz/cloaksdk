import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { parseTransactionError, validateWithdrawalAmount } from "./validation";
import { ErrorCodes, ValidationError } from "../errors";

describe("validateWithdrawalAmount", () => {
	it("includes maxWithdrawableLamports on overflow", () => {
		const available = new BN("1000000000"); // 1 SOL
		const tooLarge = Number.MAX_SAFE_INTEGER / 1e9 + 1;

		expect(() =>
			validateWithdrawalAmount(tooLarge, available, 0.3),
		).toThrow(ValidationError);

		try {
			validateWithdrawalAmount(tooLarge, available, 0.3);
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.code).toBe(ErrorCodes.INVALID_AMOUNT);
			expect(typeof ve.details?.maxWithdrawableLamports).toBe("string");
		}
	});

	it("includes maxWithdrawableLamports on insufficient balance", () => {
		const available = new BN("1000000000"); // 1 SOL
		expect(() =>
			validateWithdrawalAmount(2, available, 0.3),
		).toThrow(ValidationError);

		try {
			validateWithdrawalAmount(2, available, 0.3);
		} catch (err) {
			const ve = err as ValidationError;
			expect(ve.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);

			const maxLamports = new BN(
				String(ve.details?.maxWithdrawableLamports),
			);
			// max + fee(max) <= available
			const feeBps = 30;
			const fee = maxLamports.muln(feeBps).divn(10_000);
			expect(maxLamports.add(fee).lte(available)).toBe(true);
		}
	});
});

describe("parseTransactionError", () => {
	it("detects insufficient rent simulation errors", () => {
		const parsed = parseTransactionError(
			"Transaction results in an account (3) with insufficient funds for rent.",
		);
		expect(parsed.isInsufficientFunds).toBe(true);
		expect(parsed.isInsufficientRent).toBe(true);
	});
});
