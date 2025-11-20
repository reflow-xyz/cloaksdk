/**
 * BATCH WITHDRAW - Multiple withdrawals to maximize UTXO utilization
 *
 * When a single withdrawal exceeds available UTXO capacity (max 2 UTXOs per tx),
 * this breaks it into multiple smaller withdrawals that each fit within 2 UTXOs.
 */

import BN from "bn.js";
import type { Utxo } from "../models/utxo";
import { log, warn } from "./logger";

export interface BatchWithdrawPlan {
	withdrawals: {
		amount: number; // Amount to withdraw in this transaction (in base units: lamports or token amount)
		utxos: Utxo[]; // UTXOs to use (max 2)
	}[];
	totalAmount: number;
	totalFee: number;
}

/**
 * Calculate how to split a large withdrawal into multiple transactions
 * Each transaction can use at most 2 UTXOs as inputs
 */
export function planBatchWithdrawals(
	requestedAmount: number, // in base units (lamports for SOL, smallest unit for SPL)
	feeRate: number, // percentage (e.g., 0.3 for 0.3%)
	availableUtxos: Utxo[],
): BatchWithdrawPlan | null {
	log(
		`[SDK] Planning batch withdrawals for ${requestedAmount} base units`,
	);
	log(`[SDK] Available UTXOs: ${availableUtxos.length}`);

	// Sort UTXOs by amount descending
	const sortedUtxos = [...availableUtxos].sort((a, b) =>
		b.amount.cmp(a.amount),
	);

	const withdrawals: { amount: number; utxos: Utxo[] }[] = [];
	let remainingToWithdraw = requestedAmount;
	const usedUtxoIndices = new Set<number>();

	while (
		remainingToWithdraw > 0 &&
		usedUtxoIndices.size < sortedUtxos.length
	) {
		// Find the next 2 unused UTXOs
		const availableForThisTx: Utxo[] = [];
		for (
			let i = 0;
			i < sortedUtxos.length && availableForThisTx.length < 2;
			i++
		) {
			if (!usedUtxoIndices.has(i)) {
				availableForThisTx.push(sortedUtxos[i]);
				usedUtxoIndices.add(i);
			}
		}

		if (availableForThisTx.length === 0) {
			warn(`[SDK WARNING] No more UTXOs available`);
			break;
		}

		// Calculate how much we can withdraw with these UTXOs
		const totalInput = availableForThisTx
			.reduce((sum, utxo) => sum.add(utxo.amount), new BN(0))
			.toNumber();

		// Calculate fee for this transaction
		const feeForThisTx = Math.floor(totalInput * (feeRate / 100));
		const maxWithdrawableThisTx = totalInput - feeForThisTx;

		// Decide how much to withdraw in this transaction
		const amountThisTx = Math.min(
			remainingToWithdraw,
			maxWithdrawableThisTx,
		);

		if (amountThisTx <= 0) {
			warn(
				`[SDK WARNING] Cannot withdraw more with remaining UTXOs (too small after fees)`,
			);
			break;
		}

		withdrawals.push({
			amount: amountThisTx,
			utxos: availableForThisTx,
		});

		remainingToWithdraw -= amountThisTx;
		log(
			`[SDK] Planned withdrawal ${withdrawals.length}: ${amountThisTx} base units using ${availableForThisTx.length} UTXOs`,
		);
	}

	if (remainingToWithdraw > 0) {
		warn(
			`[SDK WARNING] Could not plan complete withdrawal. Short by ${remainingToWithdraw} base units`,
		);
		// Return partial plan
	}

	const totalAmount = withdrawals.reduce((sum, w) => sum + w.amount, 0);
	const totalFee = withdrawals.reduce((sum, w) => {
		const totalInput = w.utxos
			.reduce((s, u) => s.add(u.amount), new BN(0))
			.toNumber();
		return sum + Math.floor(totalInput * (feeRate / 100));
	}, 0);

	log(
		`[SDK] Batch plan: ${withdrawals.length} transactions, ${totalAmount} base units total, ${totalFee} base units in fees`,
	);

	return {
		withdrawals,
		totalAmount,
		totalFee,
	};
}

/**
 * Preview what a batch withdrawal would look like without executing
 */
export function previewBatchWithdrawal(
	requestedAmount: number, // in base units
	availableUtxos: Utxo[],
	feeRate: number = 0,
): {
	numTransactions: number;
	totalAmount: number;
	totalFees: number;
	breakdown: { txNum: number; amount: number; numUtxos: number }[];
} | null {
	const plan = planBatchWithdrawals(
		requestedAmount,
		feeRate,
		availableUtxos,
	);

	if (!plan) return null;

	return {
		numTransactions: plan.withdrawals.length,
		totalAmount: plan.totalAmount,
		totalFees: plan.totalFee,
		breakdown: plan.withdrawals.map((w, i) => ({
			txNum: i + 1,
			amount: w.amount,
			numUtxos: w.utxos.length,
		})),
	};
}
