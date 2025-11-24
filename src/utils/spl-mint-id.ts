/**
 * SPL Token Mint ID utilities using BLAKE2b-128 for compact representation
 *
 * This module provides functions to convert SPL token mint addresses to compact
 * numeric IDs using BLAKE2b-128 hashing, reducing the size from 76 digits to ~39 digits
 * while maintaining zero collision risk for 100M+ tokens.
 */

import { blake2b } from 'blakejs';
import bs58 from 'bs58';
import BN from 'bn.js';
import { FIELD_SIZE } from './constants';

/**
 * Convert an SPL token mint address to a compact numeric ID using BLAKE2b-128
 *
 * @param mintAddress - Base58-encoded SPL token mint address (e.g., "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
 * @returns Numeric string representation (~39 digits instead of ~76)
 *
 * @example
 * const mintId = getSplMintId("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
 * // Returns: "123456789012345678901234567890123456789" (39 digits)
 */
export function getSplMintId(mintAddress: string): string {
	// Decode base58 address to bytes
	const mintBytes = bs58.decode(mintAddress);

	// Hash with BLAKE2b-128 (16 bytes = 128 bits)
	const hash = blake2b(mintBytes, undefined, 16);

	// Convert to BN and return as string
	return new BN(Buffer.from(hash)).toString();
}

/**
 * Legacy function to get mint ID using the old method (full 32-byte mod FIELD_SIZE)
 * Used for backwards compatibility with existing UTXOs
 *
 * @param mintAddress - Base58-encoded SPL token mint address
 * @returns Numeric string representation (~76 digits, old format)
 */
export function getLegacySplMintId(mintAddress: string): string {
	const mintBytes = bs58.decode(mintAddress);
	const mintBN = new BN(mintBytes);
	return mintBN.mod(FIELD_SIZE).toString();
}

/**
 * Check if a mint ID matches a given mint address using either the new or legacy format
 * Used for filtering UTXOs during backwards compatibility transition
 *
 * @param storedMintId - The mint ID stored in a UTXO
 * @param mintAddress - The mint address to check against
 * @returns true if the stored ID matches either new or legacy format
 *
 * @example
 * const utxo = { mintAddress: "12345..." };
 * const matches = mintIdMatches(utxo.mintAddress, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
 */
export function mintIdMatches(storedMintId: string, mintAddress: string): boolean {
	const newId = getSplMintId(mintAddress);
	const legacyId = getLegacySplMintId(mintAddress);

	return storedMintId === newId || storedMintId === legacyId;
}

/**
 * Check if a mint ID is using the new BLAKE2b-128 format or legacy format
 * New format: ~39 digits (128 bits max)
 * Legacy format: ~76 digits (254 bits)
 *
 * @param mintId - The mint ID to check
 * @returns true if using new format, false if legacy
 */
export function isNewMintIdFormat(mintId: string): boolean {
	// 128 bits max = 39 digits
	// 254 bits (FIELD_SIZE) = ~77 digits
	// Use 50 as threshold to distinguish
	return mintId.length < 50;
}
