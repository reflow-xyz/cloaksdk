import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

export interface NullifierProofLike {
	inputNullifiers: ArrayLike<ArrayLike<number>>;
}

function toNullifierBuffer(input: ArrayLike<number>): Buffer {
	return Buffer.from(Array.from(input));
}

/**
 * Derive primary and cross-check nullifier PDAs from proof input nullifiers.
 */
export function deriveNullifierPdas(
	proof: NullifierProofLike,
): {
	nullifier0PDA: PublicKey;
	nullifier1PDA: PublicKey;
	nullifier2PDA: PublicKey;
	nullifier3PDA: PublicKey;
} {
	const input0 = toNullifierBuffer(proof.inputNullifiers[0]);
	const input1 = toNullifierBuffer(proof.inputNullifiers[1]);

	const [nullifier0PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier0"), input0],
		PROGRAM_ID,
	);
	const [nullifier1PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier1"), input1],
		PROGRAM_ID,
	);
	const [nullifier2PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier0"), input1],
		PROGRAM_ID,
	);
	const [nullifier3PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier1"), input0],
		PROGRAM_ID,
	);

	return {
		nullifier0PDA,
		nullifier1PDA,
		nullifier2PDA,
		nullifier3PDA,
	};
}

/**
 * Derive the two standard nullifier PDAs (used by SPL withdraw flow).
 */
export function deriveNullifierPairPdas(
	proof: NullifierProofLike,
): {
	nullifier0PDA: PublicKey;
	nullifier1PDA: PublicKey;
} {
	const input0 = toNullifierBuffer(proof.inputNullifiers[0]);
	const input1 = toNullifierBuffer(proof.inputNullifiers[1]);

	const [nullifier0PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier0"), input0],
		PROGRAM_ID,
	);
	const [nullifier1PDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("nullifier1"), input1],
		PROGRAM_ID,
	);

	return { nullifier0PDA, nullifier1PDA };
}
