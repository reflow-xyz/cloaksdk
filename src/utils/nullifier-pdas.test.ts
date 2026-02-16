import { describe, expect, it } from "vitest";
import {
	deriveNullifierPairPdas,
	deriveNullifierPdas,
} from "./nullifier-pdas";

const proof = {
	inputNullifiers: [
		Uint8Array.from({ length: 32 }, (_, i) => i + 1),
		Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
	],
};

describe("nullifier-pdas", () => {
	it("derives stable PDA pairs", () => {
		const first = deriveNullifierPairPdas(proof);
		const second = deriveNullifierPairPdas(proof);

		expect(first.nullifier0PDA.toBase58()).toBe(
			second.nullifier0PDA.toBase58(),
		);
		expect(first.nullifier1PDA.toBase58()).toBe(
			second.nullifier1PDA.toBase58(),
		);
	});

	it("derives cross-check PDAs", () => {
		const pdas = deriveNullifierPdas(proof);
		const pair = deriveNullifierPairPdas(proof);

		expect(pdas.nullifier0PDA.toBase58()).toBe(
			pair.nullifier0PDA.toBase58(),
		);
		expect(pdas.nullifier1PDA.toBase58()).toBe(
			pair.nullifier1PDA.toBase58(),
		);
		expect(pdas.nullifier2PDA.toBase58()).not.toBe(
			pdas.nullifier0PDA.toBase58(),
		);
		expect(pdas.nullifier3PDA.toBase58()).not.toBe(
			pdas.nullifier1PDA.toBase58(),
		);
	});
});
