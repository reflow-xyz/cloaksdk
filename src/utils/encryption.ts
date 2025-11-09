import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";

// Import noble hashes for key derivation (still needed for deriveUtxoPrivateKey)
import { sha256 } from "@noble/hashes/sha256";
// Import old encryption method for backward compatibility
import { ctr } from "@noble/ciphers/aes";
import { hmac } from "@noble/hashes/hmac";
import { TRANSACT_IX_DISCRIMINATOR } from "./constants";
import { Buffer } from "buffer";

import BN from "bn.js";

// Try to import Node.js crypto for hardware acceleration (AES-NI)
let nodeCrypto: typeof import('crypto') | null = null;
let hardwareAccelerationEnabled = false;
try {
	nodeCrypto = require('crypto');
	hardwareAccelerationEnabled = true;
	// Note: Node.js crypto automatically uses AES-NI instructions when available on the CPU
	// This provides 5-10x performance improvement over pure JavaScript implementations
} catch (e) {
	// Not in Node.js environment, will use @noble/ciphers fallback
}

/**
 * Check if hardware acceleration is available
 * @returns true if AES-NI hardware acceleration is enabled
 */
export function isHardwareAccelerationEnabled(): boolean {
	return hardwareAccelerationEnabled;
}
/**
 * Represents a UTXO with minimal required fields
 */
export interface UtxoData {
	amount: string;
	blinding: string;
	index: number | string;
	// Optional additional fields
	[key: string]: any;
}


/**
 * Service for handling encryption and decryption of UTXO data
 */
export class EncryptionService {
	private encryptionKey: Uint8Array | null = null;

	/**
	 * Initialize the encryption service with an encryption key
	 * @param encryptionKey The encryption key to use for encryption and decryption
	 */
	constructor(encryptionKey?: Uint8Array) {
		if (encryptionKey) {
			this.encryptionKey = encryptionKey;
		}
	}

	/**
	 * Set the encryption key directly
	 * @param encryptionKey The encryption key to set
	 */
	public setEncryptionKey(encryptionKey: Uint8Array): void {
		this.encryptionKey = encryptionKey;
	}

	/**
	 * Generate an encryption key from a signature
	 * @param signature The user's signature
	 * @returns The generated encryption key
	 */
	public deriveEncryptionKeyFromSignature(
		signature: Uint8Array,
	): Uint8Array {
		// Extract the first 31 bytes of the signature to create a deterministic key
		const encryptionKey = signature.slice(0, 31);

		// Store the key in the service
		this.encryptionKey = encryptionKey;

		return encryptionKey;
	}

	/**
	 * Encrypt data with the stored encryption key using AES-128-CTR + HMAC
	 * Uses hardware-accelerated AES-NI when available (Node.js crypto module)
	 * @param data The data to encrypt
	 * @returns The encrypted data as a Uint8Array
	 * @throws Error if the encryption key has not been generated
	 */
	public encrypt(data: Uint8Array | string): Uint8Array {
		if (!this.encryptionKey) {
			throw new Error(
				"Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.",
			);
		}

		// Convert string to Uint8Array if needed
		const dataUint8Array =
			typeof data === "string"
				? new TextEncoder().encode(data)
				: data;

		// Generate a standard initialization vector (16 bytes)
		const iv = crypto.getRandomValues(new Uint8Array(16));

		// Create a key from our encryption key (using only first 16 bytes for AES-128)
		const key = this.encryptionKey.slice(0, 16);

		// Use hardware-accelerated AES-128-CTR if available (Node.js crypto with AES-NI)
		// Otherwise fall back to @noble/ciphers pure JS implementation
		let encryptedData: Uint8Array;
		if (nodeCrypto) {
			try {
				const cipher = nodeCrypto.createCipheriv('aes-128-ctr', key, iv);
				const encrypted = Buffer.concat([
					cipher.update(dataUint8Array),
					cipher.final()
				]);
				encryptedData = new Uint8Array(encrypted);
			} catch (e) {
				// Fallback to @noble/ciphers if Node.js crypto fails
				encryptedData = ctr(key, iv).encrypt(dataUint8Array);
			}
		} else {
			// Use @noble/ciphers fallback
			encryptedData = ctr(key, iv).encrypt(dataUint8Array);
		}

		// Create an authentication tag (HMAC) to verify decryption with correct key
		const hmacKey = this.encryptionKey.slice(16, 31);
		const hmacHasher = hmac.create(sha256, hmacKey);
		hmacHasher.update(iv);
		hmacHasher.update(encryptedData);
		const authTag = hmacHasher.digest().slice(0, 16); // Use first 16 bytes of HMAC as auth tag

		// Combine: [IV (16 bytes)][Auth Tag (16 bytes)][Encrypted Data]
		const result = new Uint8Array(16 + 16 + encryptedData.length);
		result.set(iv, 0);
		result.set(authTag, 16);
		result.set(encryptedData, 32);

		return result;
	}

	/**
	 * Decrypt data with the stored encryption key using AES-128-CTR + HMAC
	 * Uses hardware-accelerated AES-NI when available (Node.js crypto module)
	 * @param encryptedData The encrypted data to decrypt
	 * @returns The decrypted data as a Uint8Array
	 * @throws Error if the encryption key has not been generated or if the wrong key is used
	 */
	public decrypt(encryptedData: Uint8Array): Uint8Array {
		if (!this.encryptionKey) {
			throw new Error(
				"Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.",
			);
		}

		// Format: [IV (16 bytes)][Auth Tag (16 bytes)][Encrypted Data]
		const iv = encryptedData.slice(0, 16);
		const authTag = encryptedData.slice(16, 32);
		const ciphertext = encryptedData.slice(32);

		// Verify HMAC authentication tag
		const hmacKey = this.encryptionKey.slice(16, 31);
		const hmacHasher = hmac.create(sha256, hmacKey);
		hmacHasher.update(iv);
		hmacHasher.update(ciphertext);
		const expectedAuthTag = hmacHasher.digest().slice(0, 16);

		// Timing-safe comparison
		let diff = 0;
		for (let i = 0; i < 16; i++) {
			diff |= authTag[i] ^ expectedAuthTag[i];
		}

		if (diff !== 0) {
			throw new Error(
				"Failed to decrypt data. Invalid encryption key or corrupted data.",
			);
		}

		// Decrypt using hardware-accelerated AES-128-CTR if available (Node.js crypto with AES-NI)
		// Otherwise fall back to @noble/ciphers pure JS implementation
		const key = this.encryptionKey.slice(0, 16);
		let decryptedData: Uint8Array;

		if (nodeCrypto) {
			try {
				const decipher = nodeCrypto.createDecipheriv('aes-128-ctr', key, iv);
				const decrypted = Buffer.concat([
					decipher.update(ciphertext),
					decipher.final()
				]);
				decryptedData = new Uint8Array(decrypted);
			} catch (e) {
				// Fallback to @noble/ciphers if Node.js crypto fails
				decryptedData = ctr(key, iv).decrypt(ciphertext);
			}
		} else {
			// Use @noble/ciphers fallback
			decryptedData = ctr(key, iv).decrypt(ciphertext);
		}

		return decryptedData;
	}

	/**
	 * Check if the encryption key has been set
	 * @returns True if the encryption key exists, false otherwise
	 */
	public hasEncryptionKey(): boolean {
		return this.encryptionKey !== null;
	}

	/**
	 * Get the encryption key (for testing purposes)
	 * @returns The current encryption key or null
	 */
	public getEncryptionKey(): Uint8Array | null {
		return this.encryptionKey;
	}

	/**
	 * Reset the encryption key (mainly for testing purposes)
	 */
	public resetEncryptionKey(): void {
		this.encryptionKey = null;
	}

	/**
	 * Encrypt a UTXO using a compact pipe-delimited format
	 * @param utxo The UTXO to encrypt
	 * @returns Promise resolving to the encrypted UTXO data as a Uint8Array
	 * @throws Error if the encryption key has not been set
	 */
	public encryptUtxo(utxo: Utxo): Uint8Array {
		if (!this.encryptionKey) {
			throw new Error(
				"Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.",
			);
		}

		// Create a compact string representation using pipe delimiter
		const utxoString = `${utxo.amount.toString()}|${utxo.blinding.toString()}|${
			utxo.index
		}|${utxo.mintAddress}`;

		// Use the regular encrypt method
		return this.encrypt(utxoString);
	}

	/**
	 * Decrypt an encrypted UTXO and parse it to a Utxo instance
	 * @param encryptedData The encrypted UTXO data
	 * @param keypair The UTXO keypair to use for the decrypted UTXO
	 * @param lightWasm Optional LightWasm instance. If not provided, a new one will be created
	 * @returns Promise resolving to the decrypted Utxo instance
	 * @throws Error if the encryption key has not been set or if decryption fails
	 */
	public decryptUtxo(
		encryptedData: Uint8Array | string,
		keypair: UtxoKeypair,
		lightWasm?: any,
	): Utxo {
		if (!this.encryptionKey) {
			throw new Error(
				"Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.",
			);
		}

		// Convert hex string to Uint8Array if needed
		const encryptedUint8Array =
			typeof encryptedData === "string"
				? Uint8Array.from(
						Buffer.from(
							encryptedData,
							"hex",
						),
				  ) // Assuming Buffer is available or polyfilled for hex conversion
				: encryptedData;

		// Decrypt the data using the regular decrypt method
		const decrypted = this.decrypt(encryptedUint8Array);

		// Parse the pipe-delimited format
		const decryptedStr = new TextDecoder().decode(decrypted);
		const [amount, blinding, index, mintAddress] =
			decryptedStr.split("|");

		if (
			!amount ||
			!blinding ||
			index === undefined ||
			mintAddress === undefined
		) {
			throw new Error("Invalid UTXO format after decryption");
		}
		// Get or create a LightWasm instance
		if (!lightWasm) {
			throw new Error("encryption: undefined lightWasm");
		}
		const wasmInstance = lightWasm;

		// Create a Utxo instance with the provided keypair
		return new Utxo({
			lightWasm: wasmInstance,
			amount: amount,
			blinding: blinding,
			keypair: keypair,
			index: Number(index),
			mintAddress: mintAddress,
		});
	}

	/**
	 * Derive a deterministic UTXO private key from the wallet's encryption key
	 * @returns A private key in hex format that can be used to create a UTXO keypair
	 * @throws Error if the encryption key has not been set
	 */
	public deriveUtxoPrivateKey(): string {
		if (!this.encryptionKey) {
			throw new Error(
				"Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.",
			);
		}

		// Use a hash function to generate a deterministic private key from the encryption key
		const hashedSeed = sha256(this.encryptionKey);

		// Convert to a hex string compatible with ethers.js private key format
		return (
			"0x" +
			Array.from(hashedSeed)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("")
		);
	}
}

// Function to serialize proof and extData (same as original withdraw script)
export function serializeProofAndExtData(
	proof: any,
	extData: any,
	discriminator: Buffer = TRANSACT_IX_DISCRIMINATOR,
) {
	// Serialize the instruction data to match what the contract expects
	const instructionData = Buffer.concat([
		discriminator,

		// Serialize proof (480 bytes)
		Buffer.from(proof.proofA),
		Buffer.from(proof.proofB),
		Buffer.from(proof.proofC),
		Buffer.from(proof.root),
		Buffer.from(proof.publicAmount),
		Buffer.from(proof.extDataHash),
		Buffer.from(proof.inputNullifiers[0]),
		Buffer.from(proof.inputNullifiers[1]),
		Buffer.from(proof.outputCommitments[0]),
		Buffer.from(proof.outputCommitments[1]),

		// Serialize ExtDataMinified (16 bytes: extAmount + fee only)
		// extData.extAmount and extData.fee are already BN objects, don't wrap them again
		Buffer.from(extData.extAmount.toTwos(64).toArray("le", 8)),
		Buffer.from(extData.fee.toArray("le", 8)),

		// Serialize encrypted outputs as Vec<u8>
		Buffer.from(
			new BN(extData.encryptedOutput1.length).toArray(
				"le",
				4,
			),
		),
		extData.encryptedOutput1,
		Buffer.from(
			new BN(extData.encryptedOutput2.length).toArray(
				"le",
				4,
			),
		),
		extData.encryptedOutput2,
	]);

	return instructionData;
}

// convert Uint8Array to base64
export function uint8ArrayToBase64(u8arr: Uint8Array) {
	const binaryString = String.fromCharCode(...u8arr);
	return btoa(binaryString);
}
