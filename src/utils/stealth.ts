import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { fetchWithRetry } from "./fetchWithRetry";
import { log } from "./logger";

/**
 * Meta-address for stealth payments.
 * The referrer generates this once and registers it with the backend.
 * The spend keypair + view secret are needed to derive stealth private keys.
 */
export interface MetaAddress {
	spendKeypair: Keypair;
	viewSecret: Uint8Array;
	viewPubkeyHex: string;
}

/**
 * A scanned stealth payment that can be swept.
 */
export interface ScannedStealth {
	stealthKeypair: Keypair;
	stealthPubkey: PublicKey;
	amount: number;
	txSignature: string;
	tokenMint?: string;
}

/**
 * Generate a new stealth meta-address for referral registration.
 *
 * Returns a Solana keypair for spending and an x25519 keypair for
 * the ECDH view key used in stealth address derivation.
 */
export function generateMetaAddress(): MetaAddress {
	const spendKeypair = Keypair.generate();
	const viewSecret = x25519.utils.randomPrivateKey();
	const viewPubkey = x25519.getPublicKey(viewSecret);
	const viewPubkeyHex = Buffer.from(viewPubkey).toString("hex");

	return { spendKeypair, viewSecret, viewPubkeyHex };
}

/**
 * Derive the stealth keypair for a specific payment.
 *
 * Reproduces the MPC derivation client-side:
 * 1. ECDH: shared_secret = x25519(view_secret, ephemeral_pubkey)
 * 2. XOR: seed = shared_secret ^ spend_pubkey_bytes
 * 3. Derive Solana keypair from seed (sha256 → ed25519)
 *
 * @param spendKeypair - The referrer's spend keypair
 * @param viewSecret - The referrer's x25519 view secret (32 bytes)
 * @param ephemeralPubkeyHex - The ephemeral public key from the backend (hex string)
 */
export function deriveStealthKeypair(
	spendKeypair: Keypair,
	viewSecret: Uint8Array,
	ephemeralPubkeyHex: string,
): Keypair {
	const ephemeralPubkey = Buffer.from(ephemeralPubkeyHex, "hex");

	// ECDH: shared_secret = x25519(view_secret, ephemeral_pubkey)
	const sharedSecret = x25519.getSharedSecret(viewSecret, ephemeralPubkey);

	// XOR shared secret with spend pubkey to get stealth seed
	const spendPubkeyBytes = spendKeypair.publicKey.toBytes();
	const stealthSeed = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		stealthSeed[i] = sharedSecret[i] ^ spendPubkeyBytes[i];
	}

	// Hash the seed to get a proper ed25519 secret key
	const secretKey = sha256(stealthSeed);

	return Keypair.fromSeed(secretKey);
}

/**
 * Scan the backend for pending referral payments.
 *
 * Fetches ephemeral pubkey data from the relayer, derives each stealth
 * keypair, and checks balances on-chain.
 *
 * @param metaAddress - The referrer's meta-address
 * @param relayerUrl - Backend API URL
 * @param connection - Solana connection
 * @returns Array of scanned stealth entries with nonzero balances
 */
export async function scanForPayments(
	metaAddress: Pick<MetaAddress, "spendKeypair" | "viewSecret">,
	relayerUrl: string,
	connection: Connection,
): Promise<ScannedStealth[]> {
	const spendPubkey = metaAddress.spendKeypair.publicKey.toString();

	const response = await fetchWithRetry(
		`${relayerUrl}/referral/scan/${spendPubkey}`,
		undefined,
		3,
	);

	const result = (await response.json()) as {
		success: boolean;
		data?: {
			entries: Array<{
				stealthPubkey: string;
				ephemeralData: string;
				amount: number;
				txSignature: string;
				tokenMint?: string;
			}>;
		};
	};

	if (!result.success || !result.data) {
		return [];
	}

	const scanned: ScannedStealth[] = [];

	for (const entry of result.data.entries) {
		try {
			const stealthKeypair = deriveStealthKeypair(
				metaAddress.spendKeypair,
				metaAddress.viewSecret,
				entry.ephemeralData,
			);

			// Verify derived address matches
			if (stealthKeypair.publicKey.toString() !== entry.stealthPubkey) {
				log(
					`Stealth address mismatch: derived ${stealthKeypair.publicKey.toString()}, expected ${entry.stealthPubkey}`,
				);
				continue;
			}

			// Check on-chain balance
			const balance = await connection.getBalance(stealthKeypair.publicKey);

			if (balance > 0) {
				scanned.push({
					stealthKeypair,
					stealthPubkey: stealthKeypair.publicKey,
					amount: balance,
					txSignature: entry.txSignature,
					tokenMint: entry.tokenMint ?? undefined,
				});
			}
		} catch (err) {
			log(`Failed to derive stealth key for entry ${entry.txSignature}: ${err}`);
		}
	}

	return scanned;
}

/**
 * Sweep SOL from stealth addresses to a destination.
 *
 * Creates and sends a transfer transaction for each stealth address.
 *
 * @param scanned - Array of scanned stealth entries to sweep
 * @param destination - Destination public key
 * @param connection - Solana connection
 * @returns Array of transaction signatures
 */
export async function sweepStealthAddresses(
	scanned: ScannedStealth[],
	destination: PublicKey,
	connection: Connection,
): Promise<string[]> {
	const signatures: string[] = [];

	for (const entry of scanned) {
		// Skip token entries — those need SPL transfer logic
		if (entry.tokenMint) {
			log(`Skipping SPL stealth sweep for ${entry.stealthPubkey.toString()} (token: ${entry.tokenMint})`);
			continue;
		}

		try {
			// Leave enough for rent-exemption (we transfer everything minus tx fee estimate)
			const balance = await connection.getBalance(entry.stealthPubkey);
			const txFee = 5000; // 5000 lamports standard fee
			const transferAmount = balance - txFee;

			if (transferAmount <= 0) {
				continue;
			}

			const { blockhash } = await connection.getLatestBlockhash();

			const message = new TransactionMessage({
				payerKey: entry.stealthKeypair.publicKey,
				recentBlockhash: blockhash,
				instructions: [
					SystemProgram.transfer({
						fromPubkey: entry.stealthKeypair.publicKey,
						toPubkey: destination,
						lamports: transferAmount,
					}),
				],
			}).compileToV0Message();

			const tx = new VersionedTransaction(message);
			tx.sign([entry.stealthKeypair]);

			const sig = await connection.sendTransaction(tx, {
				preflightCommitment: "confirmed",
			});

			signatures.push(sig);
			log(`Swept ${transferAmount / LAMPORTS_PER_SOL} SOL from stealth ${entry.stealthPubkey.toString()}: ${sig}`);
		} catch (err) {
			log(`Failed to sweep stealth ${entry.stealthPubkey.toString()}: ${err}`);
		}
	}

	return signatures;
}
