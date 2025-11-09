import { log } from "./logger";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { sha256 } from "ethers";
import { Utxo } from "../models/utxo";

// Custom buffer writer for serialization
class BufferWriter {
	private buffers: Uint8Array[] = [];

	writeBytes(bytes: Uint8Array): void {
		this.buffers.push(bytes);
	}

	writeU32(value: number): void {
		const buffer = Buffer.alloc(4);
		buffer.writeUInt32LE(value, 0);
		this.buffers.push(new Uint8Array(buffer));
	}

	writeU64(value: BN): void {
		const buffer = value.toArrayLike(Buffer, "le", 8);
		this.buffers.push(new Uint8Array(buffer));
	}

	toArray(): Uint8Array {
		const totalLength = this.buffers.reduce(
			(sum, buf) => sum + buf.length,
			0,
		);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const buf of this.buffers) {
			result.set(buf, offset);
			offset += buf.length;
		}
		return result;
	}
}

export function mockEncrypt(value: Utxo): string {
	return JSON.stringify(value);
}

export function getExtDataHash(
	extData: {
		recipient: string | PublicKey;
		extAmount: string | number | BN;
		encryptedOutput1?: string | Uint8Array; // Optional for Account Data Separation
		encryptedOutput2?: string | Uint8Array; // Optional for Account Data Separation
		fee: string | number | BN;
		feeRecipient: string | PublicKey;
		mintAddress: string | PublicKey;
		is_referred?: boolean; // Accepted but not included in hash - only for fee calculation
	},
	useNumericMintFormat: boolean = false,
): Uint8Array {
	// Convert all inputs to their appropriate types
	const recipient =
		extData.recipient instanceof PublicKey
			? extData.recipient
			: new PublicKey(extData.recipient);

	const feeRecipient =
		extData.feeRecipient instanceof PublicKey
			? extData.feeRecipient
			: new PublicKey(extData.feeRecipient);

	// For SOL, mintAddress is a numeric string (like "11111111111111111111111111111112")
	// For SPL tokens, it's a base58 PublicKey string
	log("getExtDataHash - received mintAddress:", extData.mintAddress);
	log("getExtDataHash - mintAddress type:", typeof extData.mintAddress);
	log(
		"getExtDataHash - mintAddress instanceof PublicKey:",
		extData.mintAddress instanceof PublicKey,
	);

	// Handle mint address: SOL as PublicKey, SPL tokens as numeric
	let mintAddressBytes: Uint8Array;
	const SOL_MINT = "11111111111111111111111111111112";

	// Handle mint address based on format flag
	// useNumericMintFormat=false (default): Use PublicKey format (matches on-chain for new code)
	// useNumericMintFormat=true: Use numeric format (for legacy deposits with existing UTXOs)
	if (useNumericMintFormat) {
		// Legacy mode: Convert to numeric format
		log("getExtDataHash - Using NUMERIC format for mint");
		if (extData.mintAddress instanceof PublicKey) {
			if (extData.mintAddress.toString() === SOL_MINT) {
				// SOL: use PublicKey bytes
				mintAddressBytes =
					extData.mintAddress.toBytes();
			} else {
				// SPL: convert to numeric
				const mintBN = new BN(
					extData.mintAddress.toBytes(),
				);
				const buffer = mintBN.toArrayLike(
					Buffer,
					"le",
					32,
				);
				mintAddressBytes = new Uint8Array(buffer);
			}
		} else if (extData.mintAddress === SOL_MINT) {
			// SOL as string
			const mintAddress = new PublicKey(extData.mintAddress);
			mintAddressBytes = mintAddress.toBytes();
		} else {
			// Numeric string
			const mintBN = new BN(extData.mintAddress);
			const buffer = mintBN.toArrayLike(Buffer, "le", 32);
			mintAddressBytes = new Uint8Array(buffer);
		}
	} else {
		// New mode: Always use PublicKey format (matches on-chain)
		log("getExtDataHash - Using PUBLICKEY format for mint");
		if (extData.mintAddress instanceof PublicKey) {
			mintAddressBytes = extData.mintAddress.toBytes();
		} else if (extData.mintAddress === SOL_MINT) {
			const mintAddress = new PublicKey(extData.mintAddress);
			mintAddressBytes = mintAddress.toBytes();
		} else {
			// Try to parse as PublicKey
			const mintAddress = new PublicKey(extData.mintAddress);
			mintAddressBytes = mintAddress.toBytes();
		}
	}

	// Convert to BN for proper i64/u64 handling
	const extAmount = new BN(extData.extAmount.toString());
	const fee = new BN(extData.fee.toString());

	// Handle encrypted outputs - they might not be present in Account Data Separation approach
	const encryptedOutput1 = extData.encryptedOutput1
		? new Uint8Array(Buffer.from(extData.encryptedOutput1 as any))
		: new Uint8Array(0); // Empty buffer if not provided
	const encryptedOutput2 = extData.encryptedOutput2
		? new Uint8Array(Buffer.from(extData.encryptedOutput2 as any))
		: new Uint8Array(0); // Empty buffer if not provided

	// Manual serialization using custom BufferWriter
	// This matches the Rust struct field order
	const writer = new BufferWriter();

	writer.writeBytes(recipient.toBytes());

	const extAmountValue = extAmount.toNumber();
	if (extAmountValue < 0) {
		const MAX_I64 = new BN("9223372036854775808"); // 2^63
		const unsignedValue = MAX_I64.add(MAX_I64).add(extAmount);
		writer.writeU64(unsignedValue);
	} else {
		writer.writeU64(extAmount);
	}

	writer.writeU32(encryptedOutput1.length);
	writer.writeBytes(encryptedOutput1);

	writer.writeU32(encryptedOutput2.length);
	writer.writeBytes(encryptedOutput2);

	writer.writeU64(fee);

	writer.writeBytes(feeRecipient.toBytes());
	writer.writeBytes(mintAddressBytes);

	const serializedData = writer.toArray();

	const hashHex = sha256(serializedData);
	return new Uint8Array(Buffer.from(hashHex.slice(2), "hex"));
}
