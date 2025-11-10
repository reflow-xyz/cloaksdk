/**
 * UTXO (Unspent Transaction Output) module for ZK Cash
 *
 * Provides UTXO functionality for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import { type LightWasm } from "@lightprotocol/hasher.rs";
import BN from "bn.js";
import { ethers } from "ethers";
import { randomBytes } from "crypto";
import { Keypair } from "./keypair";
import { log, warn, error as error } from "../utils/logger";

/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
export class Utxo {
	amount: BN;
	blinding: BN;
	keypair: Keypair;
	index: number;
	private lightWasm: LightWasm;
	mintAddress: string;

	constructor({
		lightWasm,
		amount = new BN(0),
		/**
		 * Tornado nova doesn't use solana eddsa with curve 25519 but their own "keypair"
		 * which is:
		 * - private key: random [31;u8]
		 * - public key: PoseidonHash(privateKey)
		 *
		 * Generate a new keypair for each UTXO
		 */
		keypair,
		blinding = Utxo.randomBN(), // Use cryptographically random 31-byte value
		index = 0,
		mintAddress = "11111111111111111111111111111112",
	}: {
		lightWasm: LightWasm;
		amount?: BN | number | string;
		keypair?: Keypair;
		blinding?: BN | number | string;
		index?: number;
		mintAddress?: string;
	}) {
		this.amount = new BN(amount.toString());
		this.blinding = new BN(blinding.toString());
		this.lightWasm = lightWasm;
		this.keypair =
			keypair ||
			new Keypair(
				ethers.Wallet.createRandom().privateKey,
				lightWasm,
			);
		this.index = index;
		this.mintAddress = mintAddress;
	}

	/**
	 * Generate a cryptographically secure random BN value for blinding factor
	 * Uses crypto.randomBytes for secure randomness instead of Math.random()
	 */
	private static randomBN(): BN {
		// Generate 4 cryptographically secure random bytes
		const randomBuffer = randomBytes(4);
		// Convert to number and ensure it's in reasonable range for transaction sizes
		const randomValue = randomBuffer.readUInt32BE(0);
		// Modulo to keep in 9-digit range for consistent transaction sizes
		return new BN((randomValue % 900000000) + 100000000);
	}

	async getCommitment(): Promise<string> {
		return this.lightWasm.poseidonHashString([
			this.amount.toString(),
			this.keypair.pubkey.toString(),
			this.blinding.toString(),
			this.mintAddress,
		]);
	}

	async getNullifier(): Promise<string> {
		const commitmentValue = await this.getCommitment();
		const signature = this.keypair.sign(
			commitmentValue,
			this.index.toString(),
		);

		return this.lightWasm.poseidonHashString([
			commitmentValue,
			this.index.toString(),
			signature,
		]);
	}

	/**
	 * Log all the UTXO's public properties and derived values in JSON format
	 * @returns Promise that resolves once all logging is complete
	 */
	async log(): Promise<void> {
		// Prepare the UTXO data object
		const utxoData: any = {
			amount: this.amount.toString(),
			blinding: this.blinding.toString(),
			index: this.index,
			keypair: {
				pubkey: this.keypair.pubkey.toString(),
			},
		};

		// Add derived values
		try {
			utxoData.commitment = await this.getCommitment();
			utxoData.nullifier = await this.getNullifier();
		} catch (error: any) {
			utxoData.error = error.message;
		}

		// Output as formatted JSON
		log(JSON.stringify(utxoData, null, 2));
	}
}
