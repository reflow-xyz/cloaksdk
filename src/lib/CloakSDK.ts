import {
	Connection,
	Keypair,
	PublicKey,
	VersionedTransaction,
} from "@solana/web3.js";
import { getHasher } from "../utils/hasher";
import { deposit } from "../utils/deposit";
import { depositSpl } from "../utils/deposit-spl";
import { withdraw } from "../utils/withdraw";
import { withdrawSpl } from "../utils/withdraw-spl";
import { getAccountSign } from "../utils/getAccountSign";
import { setVerbose, log, error } from "../utils/logger";
import { sha256 } from "@noble/hashes/sha256";
import BN from "bn.js";
import type {
	CloakSDKConfig,
	TransactionSigner,
	DepositOptions,
	DepositSplOptions,
	WithdrawOptions,
	WithdrawSplOptions,
	DepositResult,
	WithdrawResult,
	Signed,
	UtxoBalance,
} from "../types";
import { getMyUtxos, clearUtxoCache, refreshUtxos } from "../utils/getMyUtxos";
import { ErrorCodes, ConfigurationError } from "../errors";
import { fetchWithRetry } from "../utils/fetchWithRetry";
import { relayer_API_URL } from "../utils/constants";

/**
 * Cloak SDK - Privacy-preserving SOL and SPL token transfers on Solana
 *
 * This SDK provides a simple interface to deposit and withdraw SOL and SPL tokens
 * with zero-knowledge proof privacy guarantees.
 *
 * @example
 * ```typescript
 * import { CloakSDK } from '@cloak-labs/sdk';
 * import { Connection, Keypair } from '@solana/web3.js';
 *
 * const connection = new Connection('https://api.devnet.solana.com');
 * const keypair = Keypair.fromSecretKey(secretKeyBytes);
 *
 * const sdk = new CloakSDK({
 *   connection,
 *   signer: keypair,
 *   relayerUrl: 'https://your-relayer.com',
 * });
 *
 * await sdk.initialize();
 *
 * // Deposit SOL
 * const depositResult = await sdk.depositSol({
 *   amount: 0.1,
 *   onStatus: (status) => console.log(status)
 * });
 *
 * // Withdraw SOL
 * const withdrawResult = await sdk.withdrawSol({
 *   recipientAddress: 'recipient-pubkey',
 *   amount: 0.05,
 *   delayMinutes: 10 // Optional delay
 * });
 * ```
 */
/**
 * Helper to sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to check if signer is a Keypair
 */
function isKeypair(signer: TransactionSigner | Keypair): signer is Keypair {
	return "secretKey" in signer;
}

export class CloakSDK {
	private connection: Connection;
	private signer: TransactionSigner | Keypair;
	private publicKey: PublicKey;
	private relayerUrl: string;
	private programId: string;
	private verbose: boolean;
	private hasher: any = null;
	private signed: Signed | null = null;
	private initialized: boolean = false;
	private lastKnownTreeIndex: number = -1;

	/**
	 * Creates a new Cloak SDK instance
	 *
	 * @param config - SDK configuration
	 */
	constructor(config: CloakSDKConfig) {
		this.connection = config.connection;
		this.signer = config.signer;
		this.publicKey = config.signer.publicKey;
		this.relayerUrl =
			config.relayerUrl || "https://api.cloaklabs.dev";
		this.programId =
			config.programId ||
			"8wbkRNdUfjsL3hJotuHX9innLPAdChJ5qGYG41Htpmuk";
		this.verbose = config.verbose || false;

		// Set global verbose mode for logger
		setVerbose(this.verbose);
	}

	/**
	 * Initialize the SDK
	 *
	 * This must be called before any other operations.
	 * It loads the Poseidon hasher and generates the account signature.
	 *
	 * @throws {Error} If initialization fails
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			log("SDK already initialized");
			return;
		}

		try {
			log("Initializing Cloak SDK...");

			// Load the Poseidon hasher (required for ZK proofs)
			log("Loading Poseidon hasher...");
			this.hasher = await getHasher();
			log("Hasher loaded successfully");

			// Generate account signature for encryption
			log("Generating account signature...");
			this.signed = await this.generateAccountSign();
			log("Account signature generated");

			this.initialized = true;
			log("SDK initialized successfully");
		} catch (err) {
			throw new ConfigurationError(
				ErrorCodes.NOT_INITIALIZED,
				`Failed to initialize SDK: ${
					err instanceof Error
						? err.message
						: String(err)
				}`,
				undefined,
				err instanceof Error ? err : undefined,
			);
		}
	}

	/**
	 * Deposit SOL into the privacy pool
	 *
	 * @param options - Deposit options
	 * @returns Promise resolving to deposit result
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.depositSol({
	 *   amount: 0.5, // 0.5 SOL
	 *   onStatus: (status) => console.log('Status:', status)
	 * });
	 *
	 * if (result.success) {
	 *   console.log('Deposit successful:', result.signature);
	 * }
	 * ```
	 */
	async depositSol(options: DepositOptions): Promise<DepositResult> {
		this.ensureInitialized();

		try {
			log(`Depositing ${options.amount} SOL...`);

			const result = await deposit(
				options.amount,
				this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
				this.signTransaction.bind(this),
				options.maxRetries ?? 3,
				0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
			);

			if (result.success) {
				log(`Deposit successful: ${result.signature}`);
			}

			// Wait 500ms for relayer to process and index new UTXOs
			// await sleep(500);

			return result;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? err.message
					: String(err);
			log(`Deposit failed: ${errorMessage}`);
			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Deposit SPL tokens into the privacy pool
	 *
	 * @param options - SPL deposit options
	 * @returns Promise resolving to deposit result
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.depositSpl({
	 *   amount: 1000000, // 1 USDC (6 decimals)
	 *   mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	 *   onStatus: (status) => console.log('Status:', status)
	 * });
	 *
	 * if (result.success) {
	 *   console.log('SPL deposit successful:', result.signature);
	 * }
	 * ```
	 */
	async depositSpl(options: DepositSplOptions): Promise<DepositResult> {
		this.ensureInitialized();

		try {
			log(
				`Depositing ${options.amount} tokens (${options.mintAddress})...`,
			);

			const result = await depositSpl(
				options.amount,
				options.mintAddress,
				this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
				this.signTransaction.bind(this),
				options.maxRetries ?? 3,
				0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
			);

			if (result.success) {
				log(
					`SPL deposit successful: ${result.signature}`,
				);
			}

			// Wait 500ms for relayer to process and index new UTXOs
			// await sleep(500);

			return result;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? err.message
					: String(err);
			log(`SPL deposit failed: ${errorMessage}`);
			return {
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Withdraw SOL from the privacy pool
	 *
	 * @param options - Withdraw options
	 * @returns Promise resolving to withdraw result
	 *
	 * @example
	 * ```typescript
	 * // Immediate withdrawal
	 * const result = await sdk.withdrawSol({
	 *   recipientAddress: 'recipient-pubkey-string',
	 *   amount: 0.3,
	 * });
	 *
	 * // Delayed withdrawal (executes after 30 minutes)
	 * const delayedResult = await sdk.withdrawSol({
	 *   recipientAddress: new PublicKey('...'),
	 *   amount: 0.3,
	 *   delayMinutes: 30,
	 * });
	 *
	 * if (delayedResult.success) {
	 *   console.log('Withdrawal scheduled:', delayedResult.delayedWithdrawalId);
	 *   console.log('Will execute at:', delayedResult.executeAt);
	 * }
	 * ```
	 */
	async withdrawSol(options: WithdrawOptions): Promise<WithdrawResult> {
		this.ensureInitialized();

		try {
			const recipientPubkey =
				typeof options.recipientAddress === "string"
					? new PublicKey(
							options.recipientAddress,
					  )
					: options.recipientAddress;

			log(
				`Withdrawing ${
					options.amount
				} SOL to ${recipientPubkey.toString()}...`,
			);

			const result = await withdraw(
				recipientPubkey,
				options.amount,
				this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
				options.delayMinutes,
				options.maxRetries ?? 3,
				0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
				options.providedUtxos,
			);

			if (result.success) {
				if (options.delayMinutes) {
					log(
						`Withdrawal scheduled (ID: ${result.delayedWithdrawalId})`,
					);
				} else {
					log("Withdrawal successful");
				}
			}

			// Wait 500ms for relayer to process and index new UTXOs
			// await sleep(500);

			return result;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? err.message
					: String(err);
			log(`Withdrawal failed: ${errorMessage}`);
			return {
				isPartial: false,
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Withdraw SPL tokens from the privacy pool
	 *
	 * @param options - SPL withdraw options
	 * @returns Promise resolving to withdraw result
	 *
	 * @example
	 * ```typescript
	 * // Immediate SPL withdrawal
	 * const result = await sdk.withdrawSpl({
	 *   recipientAddress: 'recipient-pubkey-string',
	 *   amount: 500000, // 0.5 USDC
	 *   mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	 * });
	 *
	 * // Delayed SPL withdrawal
	 * const delayedResult = await sdk.withdrawSpl({
	 *   recipientAddress: new PublicKey('...'),
	 *   amount: 500000,
	 *   mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	 *   delayMinutes: 60,
	 * });
	 * ```
	 */
	async withdrawSpl(
		options: WithdrawSplOptions,
	): Promise<WithdrawResult> {
		this.ensureInitialized();

		try {
			const recipientPubkey =
				typeof options.recipientAddress === "string"
					? new PublicKey(
							options.recipientAddress,
					  )
					: options.recipientAddress;

			log(
				`Withdrawing ${options.amount} tokens (${
					options.mintAddress
				}) to ${recipientPubkey.toString()}...`,
			);

			const result = await withdrawSpl(
				recipientPubkey,
				options.amount,
				options.mintAddress,
				this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
				options.delayMinutes,
				options.maxRetries ?? 3,
				0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
				options.providedUtxos,
			);

			if (result.success) {
				if (options.delayMinutes) {
					log(
						`SPL withdrawal scheduled (ID: ${result.delayedWithdrawalId})`,
					);
				} else {
					log("SPL withdrawal successful");
				}
			}

			// Wait 500ms for relayer to process and index new UTXOs
			// await sleep(500);

			return result;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? err.message
					: String(err);
			log(`SPL withdrawal failed: ${errorMessage}`);
			return {
				isPartial: false,
				success: false,
				error: errorMessage,
			};
		}
	}
	/**
	 * Deposit SOL, wait for relayer to process, then immediately withdraw
	 *
	 * This is a convenience method that combines deposit and withdrawal operations
	 * with an automatic wait period for the relayer to process the deposit.
	 *
	 * @param options - Full transfer options
	 * @returns Promise resolving to an object with deposit and withdraw results
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.fullTransfer({
	 *   depositAmount: 0.1,  // Deposit 0.1 SOL
	 *   withdrawAmount: 0.05, // Withdraw 0.05 SOL
	 *   recipientAddress: sdk.getPublicKey(), // Withdraw to self
	 *   waitSeconds: 10, // Wait 10 seconds for relayer (default: 10)
	 *   onStatus: (status) => console.log(status)
	 * });
	 *
	 * if (result.depositResult.success && result.withdrawResult.success) {
	 *   console.log('Full transfer complete!');
	 * }
	 * ```
	 */
	async fullTransfer(options: {
		depositAmount: number;
		withdrawAmount: number;
		recipientAddress?: PublicKey | string;
		waitSeconds?: number;
		onStatus?: (status: string) => void;
	}): Promise<{
		depositResult: DepositResult;
		withdrawResult: WithdrawResult;
	}> {
		this.ensureInitialized();

		const waitSeconds = options.waitSeconds ?? 10;
		const recipientPubkey = options.recipientAddress
			? typeof options.recipientAddress === "string"
				? new PublicKey(options.recipientAddress)
				: options.recipientAddress
			: this.publicKey;

		const statusCallback = options.onStatus || (() => {});

		// Step 1: Deposit
		statusCallback(`Depositing ${options.depositAmount} SOL...`);
		const depositResult = await this.depositSol({
			amount: options.depositAmount,
			onStatus: statusCallback,
		});

		if (!depositResult.success) {
			log(
				`Full transfer failed at deposit: ${depositResult.error}`,
			);
			return {
				depositResult,
				withdrawResult: {
					success: false,
					isPartial: false,
					error: "Deposit failed, withdrawal skipped",
				},
			};
		}

		statusCallback(
			`Deposit successful! Signature: ${depositResult.signature}`,
		);

		// Step 2: Wait for relayer
		// statusCallback(`Waiting ${waitSeconds} seconds for relayer to process deposit...`);
		// await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

		// Step 3: Withdraw
		statusCallback(
			`Withdrawing ${
				options.withdrawAmount
			} SOL to ${recipientPubkey.toString()}...`,
		);
		const withdrawResult = await this.withdrawSol({
			recipientAddress: recipientPubkey,
			amount: options.withdrawAmount,
			onStatus: statusCallback,
			delayMinutes: Math.floor(waitSeconds / 60),
		});

		if (withdrawResult.success) {
			statusCallback("Full transfer completed successfully!");
		} else {
			statusCallback(
				`Full transfer completed with withdrawal error: ${withdrawResult.error}`,
			);
		}

		return {
			depositResult,
			withdrawResult,
		};
	}

	/**
	 * Query the current tree state and check if it has changed
	 * If changed, triggers UTXO cache refresh
	 */
	private async checkAndRefreshTreeState(): Promise<void> {
		try {
			const response = await fetchWithRetry(
				`${relayer_API_URL}/merkle/root`,
				undefined,
				3,
			);

			if (response.ok) {
				const treeState = (await response.json()) as {
					root: string;
					nextIndex: number;
				};

				// Check if tree has changed (new UTXOs added)
				if (
					this.lastKnownTreeIndex !== -1 &&
					treeState.nextIndex >
						this.lastKnownTreeIndex
				) {
					// Tree has changed - new UTXOs were added
					// getMyUtxos will automatically fetch the new ones via its cache mechanism
				}

				// Update last known index
				this.lastKnownTreeIndex = treeState.nextIndex;
			}
		} catch (err) {
			// Silently fail - balance check will proceed with cached data
		}
	}

	/**
	 * Get SOL balance in the privacy pool
	 *
	 * @returns Promise resolving to UTXO balance information
	 *
	 * @example
	 * ```typescript
	 * const balance = await sdk.getSolBalance();
	 * console.log('SOL balance:', balance.total.toNumber() / 1e9, 'SOL');
	 * console.log('Number of UTXOs:', balance.count);
	 * ```
	 */
	async getSolBalance(utxoWalletSigned?: Signed, forceRefresh: boolean = false): Promise<UtxoBalance> {
		this.ensureInitialized();

		// Wait 500ms to allow relayer to process recent transactions
		// await sleep(500);

		try {
			// Check if tree state has changed before fetching UTXOs
			await this.checkAndRefreshTreeState();

			const utxos = await getMyUtxos(
				utxoWalletSigned || this.signed!,
				this.connection,
				undefined,
				this.hasher,
				forceRefresh, // Pass forceRefresh to getMyUtxos
			);

			// Filter for SOL UTXOs (mint address = "11111111111111111111111111111112")
			const solUtxos = utxos.filter(
				(utxo) =>
					utxo.mintAddress ===
						"11111111111111111111111111111112" &&
					utxo.amount.gt(new BN(0)),
			);

			log(
				`[SDK] Total UTXOs from getMyUtxos: ${utxos.length}`,
			);
			log(`[SDK] SOL UTXOs: ${solUtxos.length}`);

			// Log each UTXO for debugging
			solUtxos.forEach((utxo, i) => {
				log(
					`[SDK]   UTXO ${
						i + 1
					}: amount=${utxo.amount.toString()} lamports, mintAddress=${
						utxo.mintAddress
					}, index=${utxo.index}`,
				);
			});

			const total = solUtxos.reduce(
				(sum, utxo) => sum.add(utxo.amount),
				new BN(0),
			);

			log(
				`[SDK] Total SOL balance: ${total.toString()} lamports (across ${
					solUtxos.length
				} UTXOs)`,
			);

			return {
				total,
				count: solUtxos.length,
				mintAddress: "11111111111111111111111111111112",
			};
		} catch (err) {
			throw new ConfigurationError(
				ErrorCodes.INTERNAL_ERROR,
				`Failed to get SOL balance: ${
					err instanceof Error
						? err.message
						: String(err)
				}`,
				undefined,
				err instanceof Error ? err : undefined,
			);
		}
	}

	/**
	 * Get SPL token balance in the privacy pool
	 *
	 * @param mintAddress - SPL token mint address
	 * @returns Promise resolving to UTXO balance information
	 *
	 * @example
	 * ```typescript
	 * const balance = await sdk.getSplBalance('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	 * console.log('USDC balance:', balance.total.toNumber() / 1e6);
	 * console.log('Number of UTXOs:', balance.count);
	 * ```
	 */
	async getSplBalance(
		mintAddress: string,
		utxoWalletSigned?: Signed,
		forceRefresh: boolean = false,
	): Promise<UtxoBalance> {
		this.ensureInitialized();

		// Wait 500ms to allow relayer to process recent transactions
		// await sleep(500);

		try {
			// Check if tree state has changed before fetching UTXOs
			await this.checkAndRefreshTreeState();

			// Convert mint address to numeric format
			const mint = new PublicKey(mintAddress);
			const mintBytes = mint.toBytes();
			const mintBN = new BN(mintBytes);
			const FIELD_SIZE = new BN(
				"21888242871839275222246405745257275088548364400416034343698204186575808495617",
			);
			const mintAddressNumeric = mintBN
				.mod(FIELD_SIZE)
				.toString();

			const utxos = await getMyUtxos(
				utxoWalletSigned || this.signed!,
				this.connection,
				undefined,
				this.hasher,
				forceRefresh, // Pass forceRefresh to getMyUtxos
			);

			// Filter for this specific mint
			const tokenUtxos = utxos.filter(
				(utxo) =>
					utxo.mintAddress ===
						mintAddressNumeric &&
					utxo.amount.gt(new BN(0)),
			);

			log(
				`[SDK] Total UTXOs from getMyUtxos: ${utxos.length}`,
			);
			log(
				`[SDK] UTXOs matching mint ${mintAddress}: ${tokenUtxos.length}`,
			);

			// Log each UTXO for debugging
			tokenUtxos.forEach((utxo, i) => {
				log(
					`[SDK]   UTXO ${
						i + 1
					}: amount=${utxo.amount.toString()}, mintAddress=${
						utxo.mintAddress
					}, index=${utxo.index}`,
				);
			});

			const total = tokenUtxos.reduce(
				(sum, utxo) => sum.add(utxo.amount),
				new BN(0),
			);

			log(
				`[SDK] Total balance: ${total.toString()} (across ${
					tokenUtxos.length
				} UTXOs)`,
			);

			return {
				total,
				count: tokenUtxos.length,
				mintAddress: mintAddressNumeric,
			};
		} catch (err) {
			throw new ConfigurationError(
				ErrorCodes.INTERNAL_ERROR,
				`Failed to get SPL balance: ${
					err instanceof Error
						? err.message
						: String(err)
				}`,
				undefined,
				err instanceof Error ? err : undefined,
			);
		}
	}

	/**
	 * Get the user's public key
	 *
	 * @returns User's Solana public key
	 */
	getPublicKey(): PublicKey {
		return this.publicKey;
	}

	/**
	 * Clear the UTXO cache
	 * Call this to force a fresh fetch on the next operation
	 */
	clearCache(): void {
		clearUtxoCache();
	}

	/**
	 * Force refresh all UTXOs
	 * Clears cache and fetches everything fresh
	 *
	 * @returns Promise resolving to array of fresh UTXOs
	 */
	async refreshUtxos(): Promise<any[]> {
		if (!this.signed || !this.hasher) {
			throw new ConfigurationError(
				ErrorCodes.NOT_INITIALIZED,
				"SDK not initialized. Call initialize() first.",
			);
		}
		return await refreshUtxos(
			this.signed,
			this.connection,
			undefined,
			this.hasher,
		);
	}

	/**
	 * Get the connection instance
	 *
	 * @returns Solana connection instance
	 */
	getConnection(): Connection {
		return this.connection;
	}

	/**
	 * Generate account signature for UTXO encryption
	 * Works with both Keypair and wallet adapter
	 *
	 * For wallet adapters, we derive a deterministic signature from the public key
	 * to avoid requiring user approval every time.
	 *
	 * @returns Promise resolving to signed account info
	 * @private
	 */
	private async generateAccountSign(): Promise<Signed> {
		if (isKeypair(this.signer)) {
			return await getAccountSign(this.signer);
		} else {
			// For wallet adapters, create a deterministic signature from the public key
			// This avoids requiring user approval for account initialization
			const message = new TextEncoder().encode(
				"Cloak Privacy Account",
			);
			const publicKeyBytes = this.publicKey.toBytes();

			// Create a deterministic "signature" by hashing the public key + message
			// This is used for encryption key derivation, not authentication
			const combined = new Uint8Array(
				publicKeyBytes.length + message.length,
			);
			combined.set(publicKeyBytes);
			combined.set(message, publicKeyBytes.length);
			const hash = sha256(combined);

			// Extend to 64 bytes for signature format
			const signature = new Uint8Array(64);
			signature.set(hash);
			signature.set(hash, 32);

			return {
				publicKey: this.publicKey,
				signature,
			};
		}
	}

	/**
	 * Sign a transaction with the user's signer
	 *
	 * @param transaction - Versioned transaction to sign
	 * @returns Promise resolving to signed transaction
	 * @private
	 */
	private async signTransaction(
		transaction: VersionedTransaction,
	): Promise<VersionedTransaction> {
		if (isKeypair(this.signer)) {
			transaction.sign([this.signer]);
			return transaction;
		} else {
			return await this.signer.signTransaction(transaction);
		}
	}

	/**
	 * Ensure SDK is initialized
	 *
	 * @throws {Error} If SDK is not initialized
	 * @private
	 */
	private ensureInitialized(): void {
		if (!this.initialized) {
			throw new ConfigurationError(
				ErrorCodes.NOT_INITIALIZED,
				"SDK not initialized. Call initialize() first.",
			);
		}
	}
}
