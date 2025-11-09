import { log, warn, error as error } from "./logger";
import { Connection, PublicKey } from "@solana/web3.js";
import {
	getAssociatedTokenAddress,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { relayer_API_URL, PROGRAM_ID } from "./constants";
import { fetchWithRetry } from "./fetchWithRetry";

/**
 * Token account derivation utilities for SPL token operations
 */

// Get relayer public key from the backend API
export async function getRelayerPublicKey(): Promise<PublicKey> {
	try {
		const response = await fetchWithRetry(
			`${relayer_API_URL}/relayer`,
			undefined,
			3,
		);

		if (!response.ok) {
			throw new Error(
				`Failed to fetch relayer public key: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as {
			success?: boolean;
			relayer?: { publicKey?: string };
		};

		if (!data.success || !data.relayer?.publicKey) {
			throw new Error("Invalid relayer response format");
		}

		return new PublicKey(data.relayer.publicKey);
	} catch (err) {
		error("Failed to get relayer public key:", err);
		throw err;
	}
}

/**
 * Derive all required token accounts for SPL operations
 * @param recipientWallet - Recipient wallet public key
 * @param mintAddress - Token mint address
 * @param globalConfigPubkey - Global config PDA public key
 * @param feeRecipientPubkey - Fee recipient wallet public key
 * @param relayerPubkey - Relayer wallet public key
 * @returns Object containing all derived token account addresses
 */
export async function deriveTokenAccounts(
	recipientWallet: PublicKey,
	mintAddress: PublicKey,
	globalConfigPubkey: PublicKey,
	feeRecipientPubkey: PublicKey,
	relayerPubkey: PublicKey,
): Promise<{
	recipientTokenAccount: PublicKey;
	treeAta: PublicKey;
	feeRecipientAta: PublicKey;
	signerTokenAccount: PublicKey;
}> {
	try {
		// Derive recipient's ATA
		const recipientTokenAccount = await getAssociatedTokenAddress(
			mintAddress,
			recipientWallet,
			false, // allowOwnerOffCurve
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// Derive tree's ATA (owned by global_config PDA)
		const treeAta = await getAssociatedTokenAddress(
			mintAddress,
			globalConfigPubkey,
			true, // allowOwnerOffCurve - needed for PDAs
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// Derive fee recipient's ATA
		const feeRecipientAta = await getAssociatedTokenAddress(
			mintAddress,
			feeRecipientPubkey,
			false,
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// Derive relayer's token account (for signing)
		const signerTokenAccount = await getAssociatedTokenAddress(
			mintAddress,
			relayerPubkey,
			false,
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		return {
			recipientTokenAccount,
			treeAta,
			feeRecipientAta,
			signerTokenAccount,
		};
	} catch (err) {
		error("Failed to derive token accounts:", err);
		throw err;
	}
}

/**
 * Get global config PDA
 */
export function getGlobalConfigPDA(): PublicKey {
	const [globalConfigPDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("global_config")],
		PROGRAM_ID,
	);
	return globalConfigPDA;
}

/**
 * Check if a token account exists
 * @param connection - Solana connection
 * @param tokenAccount - Token account public key to check
 * @returns true if account exists, false otherwise
 */
export async function tokenAccountExists(
	connection: Connection,
	tokenAccount: PublicKey,
): Promise<boolean> {
	try {
		const accountInfo = await connection.getAccountInfo(
			tokenAccount,
		);
		return accountInfo !== null;
	} catch (err) {
		error("Error checking token account existence:", err);
		return false;
	}
}

/**
 * Get token balance for a specific token account
 * @param connection - Solana connection
 * @param tokenAccount - Token account public key
 * @param decimals - Token decimals (optional, if provided will return human-readable balance)
 * @returns Token balance as number (in base units if decimals not provided, otherwise human-readable)
 */
export async function getTokenBalance(
	connection: Connection,
	tokenAccount: PublicKey,
	decimals?: number,
): Promise<number> {
	try {
		const balance = await connection.getTokenAccountBalance(
			tokenAccount,
		);
		const baseBalance = Number(balance.value.amount);

		// If decimals provided, convert to human-readable format
		if (decimals !== undefined) {
			return baseBalance / Math.pow(10, decimals);
		}

		return baseBalance;
	} catch (error: any) {
		// Account not found is expected when user hasn't received this token yet
		if (error?.message?.includes("could not find account")) {
			return 0;
		}
		error("Error fetching token balance:", error);
		return 0;
	}
}

/**
 * Validate mint address format
 * @param mintAddress - Mint address string to validate
 * @returns true if valid, false otherwise
 */
export function isValidMintAddress(mintAddress: string): boolean {
	try {
		const pubkey = new PublicKey(mintAddress);
		return PublicKey.isOnCurve(pubkey.toBytes());
	} catch {
		return false;
	}
}

/**
 * Check if mint is native SOL (System Program)
 * @param mintAddress - Mint address to check
 * @returns true if native SOL, false if SPL token
 */
export function isNativeSOL(mintAddress: PublicKey): boolean {
	return mintAddress.equals(
		new PublicKey("11111111111111111111111111111111"),
	);
}

/**
 * Get user's token account address for a specific mint
 * @param userWallet - User wallet public key
 * @param mintAddress - Token mint address
 * @returns Associated token account address
 */
export async function getUserTokenAccount(
	userWallet: PublicKey,
	mintAddress: PublicKey,
): Promise<PublicKey> {
	return await getAssociatedTokenAddress(
		mintAddress,
		userWallet,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
}
