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
	BatchDepositOptions,
	BatchDepositSplOptions,
	WithdrawOptions,
	WithdrawSplOptions,
	BatchWithdrawOptions,
	BatchWithdrawSplOptions,
	DepositResult,
	BatchDepositResult,
	WithdrawResult,
	BatchWithdrawResult,
	Signed,
	UtxoBalance,
} from "../types";
import { getMyUtxos, clearUtxoCache, refreshUtxos } from "../utils/getMyUtxos";
import { planBatchDeposits, planBatchSplDeposits } from "../utils/batch-deposit";
import { ErrorCodes, ConfigurationError } from "../errors";
import { fetchWithRetry } from "../utils/fetchWithRetry";
import { relayer_API_URL, CIRCUIT_PATH } from "../utils/constants";

/**
 * Cloak SDK - Privacy-preserving SOL and SPL token transfers on Solana
 *
 * This SDK provides a simple interface to deposit and withdraw SOL and SPL tokens
 * with zero-knowledge proof privacy guarantees.
 *
 * @example
 * ```typescript
 * import { CloakSDK } from '@cloak-dev/sdk';
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
	private circuitPath: string;
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
			config.relayerUrl || relayer_API_URL;
		this.programId =
			config.programId ||
			"8wbkRNdUfjsL3hJotuHX9innLPAdChJ5qGYG41Htpmuk";
		this.verbose = config.verbose || false;
		this.circuitPath = config.circuitPath || CIRCUIT_PATH;

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
				this.relayerUrl,
				this.circuitPath,
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
				this.relayerUrl,
				this.circuitPath,
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
	 * Batch deposit SOL with denomination breakdown and single wallet signature
	 *
	 * This method optimizes large deposits by breaking them into standard denominations
	 * (100, 10, 1, 0.1, 0.01, 0.001 SOL) for maximum privacy mixing. Uses signAllTransactions
	 * for single wallet popup experience.
	 *
	 * @param options - Batch deposit options
	 * @returns Promise resolving to batch deposit result
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.batchDepositSol({
	 *   amount: 15.5, // Will be split into denominations
	 *   onStatus: (status) => console.log('Status:', status)
	 * });
	 *
	 * console.log(`Deposited in ${result.signatures.length} transactions`);
	 * ```
	 */
	async batchDepositSol(options: BatchDepositOptions): Promise<BatchDepositResult> {
		this.ensureInitialized();

		try {
			log(`Batch depositing ${options.amount} SOL with denomination breakdown...`);

			// Plan the batch deposit
			const plan = planBatchDeposits(options.amount);
			if (!plan) {
				throw new Error(`Amount ${options.amount} too small for batch deposit`);
			}

			log(`Planned ${plan.totalDeposits} deposits: ${plan.deposits.map(d => d.amount).join(', ')} SOL`);
			options.onStatus?.(`Planning ${plan.totalDeposits} deposits...`);

			// Check if signAllTransactions is available
			const signAllTxs = 'signAllTransactions' in this.signer ? this.signer.signAllTransactions : undefined;
			if (!signAllTxs) {
				throw new Error('Batch deposits require signAllTransactions. Please update your wallet or use individual deposits.');
			}

			// Build all deposit transactions in parallel
			options.onStatus?.(`Generating ${plan.totalDeposits} ZK proofs in parallel...`);
			const unsignedTransactions: VersionedTransaction[] = [];

			const buildPromises = plan.deposits.map(async (depositPlan, index) => {
				const progress = `[${index + 1}/${plan.totalDeposits}]`;
				try {
					log(`${progress} Building transaction for ${depositPlan.amount} SOL`);

					// Use the existing deposit function but build transaction only
					const tx = await this.buildDepositTransaction(
						depositPlan.amount,
						(status: string) => options.onStatus?.(`${progress} ${status}`),
						index,
						options.utxoWalletSigned,
						options.utxoWalletSignTransaction
					);

					log(`${progress} Transaction built successfully`);
					return tx;
				} catch (err) {
					error(`${progress} Failed to build transaction: ${err}`);
					throw err;
				}
			});

			try {
				const transactions = await Promise.all(buildPromises);
				unsignedTransactions.push(...transactions);
				log(`All ${unsignedTransactions.length} transactions built successfully`);
			} catch (err) {
				throw new Error(`Failed to build batch deposit transactions: ${err}`);
			}

			// Sign all transactions at once
			options.onStatus?.(`Please sign all ${unsignedTransactions.length} transactions in your wallet...`);
			let signedTransactions: VersionedTransaction[];

			try {
				signedTransactions = await signAllTxs(unsignedTransactions);
				log(`All ${signedTransactions.length} transactions signed`);
			} catch (err) {
				throw new Error('User rejected signature request');
			}

			// Submit all transactions
			options.onStatus?.('Submitting transactions...');
			const signatures: string[] = [];
			let successCount = 0;

			for (let i = 0; i < signedTransactions.length; i++) {
				const signedTx = signedTransactions[i];
				const amount = plan.deposits[i].amount;
				const progress = `[${i + 1}/${signedTransactions.length}]`;

				try {
					options.onStatus?.(`Submitting ${i + 1}/${signedTransactions.length} transactions...`);
					log(`${progress} Submitting ${amount} SOL deposit...`);

					// Submit via relayer
					const signature = await this.submitDepositTransaction(signedTx);
					signatures.push(signature);
					successCount++;

					log(`${progress} Transaction submitted: ${signature}`);

					// Small delay between submissions for backend processing
					if (i < signedTransactions.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				} catch (err) {
					error(`${progress} Failed to submit: ${err}`);
					// Continue with remaining transactions
				}
			}

			// Refresh UTXOs
			options.onStatus?.('Refreshing UTXOs...');
			await this.refreshUtxos();

			log(`Batch deposit complete: ${successCount}/${plan.totalDeposits} successful`);

			return {
				success: successCount > 0,
				signatures,
				successCount,
				totalCount: plan.totalDeposits,
				error: successCount < plan.totalDeposits ? `Only ${successCount}/${plan.totalDeposits} deposits succeeded` : undefined
			};

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log(`Batch deposit failed: ${errorMessage}`);
			return {
				success: false,
				signatures: [],
				successCount: 0,
				totalCount: 0,
				error: errorMessage,
			};
		}
	}

	/**
	 * Batch deposit SPL tokens with denomination breakdown and single wallet signature
	 *
	 * Similar to batchDepositSol but for SPL tokens. Breaks large amounts into
	 * standard denominations for maximum privacy.
	 *
	 * @param options - Batch SPL deposit options
	 * @returns Promise resolving to batch deposit result
	 */
	async batchDepositSpl(options: BatchDepositSplOptions): Promise<BatchDepositResult> {
		this.ensureInitialized();

		try {
			log(`Batch depositing SPL tokens (${options.mintAddress})...`);

			// Determine decimals for the token (simplified - you may want to fetch this)
			const decimals = 9; // Default to 9, but you should fetch actual decimals

			// Plan the batch deposit
			const plan = planBatchSplDeposits(options.amount, decimals);
			if (!plan) {
				throw new Error(`Amount too small for batch SPL deposit`);
			}

			log(`Planned ${plan.totalDeposits} SPL deposits`);
			options.onStatus?.(`Planning ${plan.totalDeposits} deposits...`);

			// Check if signAllTransactions is available
			const signAllTxs = 'signAllTransactions' in this.signer ? this.signer.signAllTransactions : undefined;
			if (!signAllTxs) {
				throw new Error('Batch deposits require signAllTransactions. Please update your wallet.');
			}

			// Build all SPL deposit transactions in parallel
			options.onStatus?.(`Generating ${plan.totalDeposits} ZK proofs in parallel...`);

			const buildPromises = plan.deposits.map(async (depositPlan, index) => {
				const progress = `[${index + 1}/${plan.totalDeposits}]`;
				try {
					// Build SPL deposit transaction
					return await this.buildSplDepositTransaction(
						depositPlan.amount,
						options.mintAddress,
						(status: string) => options.onStatus?.(`${progress} ${status}`),
						index,
						options.utxoWalletSigned,
						options.utxoWalletSignTransaction
					);
				} catch (err) {
					error(`${progress} Failed to build SPL transaction: ${err}`);
					throw err;
				}
			});

			const unsignedTransactions = await Promise.all(buildPromises);

			// Sign and submit similar to SOL batch deposit
			options.onStatus?.(`Please sign all ${unsignedTransactions.length} transactions in your wallet...`);
			const signedTransactions = await signAllTxs(unsignedTransactions);

			options.onStatus?.('Submitting transactions...');
			const signatures: string[] = [];
			let successCount = 0;

			for (let i = 0; i < signedTransactions.length; i++) {
				try {
					const signature = await this.submitSplDepositTransaction(signedTransactions[i]);
					signatures.push(signature);
					successCount++;
					
					if (i < signedTransactions.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				} catch (err) {
					error(`Failed to submit SPL transaction ${i + 1}: ${err}`);
				}
			}

			await this.refreshUtxos();

			return {
				success: successCount > 0,
				signatures,
				successCount,
				totalCount: plan.totalDeposits,
				error: successCount < plan.totalDeposits ? `Only ${successCount}/${plan.totalDeposits} deposits succeeded` : undefined
			};

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				signatures: [],
				successCount: 0,
				totalCount: 0,
				error: errorMessage,
			};
		}
	}

	/**
	 * Build a deposit transaction without submitting it
	 * (Internal helper method)
	 */
	private async buildDepositTransaction(
		amount: number,
		onStatus?: (status: string) => void,
		transactionIndex?: number,
		utxoWalletSigned?: Signed,
		utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>
	): Promise<VersionedTransaction> {
		// Import the deposit function dynamically to avoid circular dependencies
		const { deposit } = await import('../utils/deposit');
		
		// Create a custom signTransaction function that just returns the unsigned transaction
		let builtTransaction: VersionedTransaction | null = null;
		
		const captureTransaction = async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
			builtTransaction = tx;
			return tx; // Return unsigned transaction
		};
		
		try {
			// Call deposit with buildOnly flag to prevent submission
			const result = await deposit(
				amount,
				utxoWalletSigned || this.signed!,
				this.connection,
				onStatus,
				this.hasher,
				captureTransaction, // Intercept the transaction
				1, // maxRetries
				0, // retryCount
				utxoWalletSigned,
				utxoWalletSignTransaction,
				this.relayerUrl,
				this.circuitPath,
				transactionIndex, // Pass transaction index for unique dummy UTXOs in batch deposits
				true, // forceFreshDeposit: Skip UTXO fetching for batch deposits to avoid conflicts
				true // buildOnly: Only build the transaction, don't submit it
			);
			
			// Get the transaction from the result
			if (result.transaction) {
				builtTransaction = result.transaction;
			}
		} catch (err) {
			throw new Error(`Failed to build deposit transaction: ${err}`);
		}
		
		if (!builtTransaction) {
			throw new Error('Failed to capture transaction during deposit build');
		}
		
		return builtTransaction;
	}

	/**
	 * Build an SPL deposit transaction without submitting it
	 * (Internal helper method)
	 */
	private async buildSplDepositTransaction(
		amount: number,
		mintAddress: string,
		onStatus?: (status: string) => void,
		transactionIndex?: number,
		utxoWalletSigned?: Signed,
		utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>
	): Promise<VersionedTransaction> {
		// Import the depositSpl function dynamically
		const { depositSpl } = await import('../utils/deposit-spl');
		
		// Create a transaction capture mechanism
		let builtTransaction: VersionedTransaction | null = null;
		
		const captureTransaction = async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
			builtTransaction = tx;
			return tx; // Return unsigned transaction
		};
		
		try {
			// Call depositSpl but intercept the transaction
			await depositSpl(
				amount,
				mintAddress,
				utxoWalletSigned || this.signed!,
				this.connection,
				onStatus,
				this.hasher,
				captureTransaction, // Intercept the transaction
				1, // maxRetries
				0, // retryCount
				utxoWalletSigned,
				utxoWalletSignTransaction,
				this.relayerUrl,
				this.circuitPath
			);
		} catch (err) {
			// Expected to fail at submission, but we captured the transaction
			if (!builtTransaction) {
				throw new Error(`Failed to build SPL deposit transaction: ${err}`);
			}
		}
		
		if (!builtTransaction) {
			throw new Error('Failed to capture SPL transaction during build');
		}
		
		return builtTransaction;
	}

	/**
	 * Submit a built deposit transaction
	 * (Internal helper method)
	 */
	private async submitDepositTransaction(signedTx: VersionedTransaction): Promise<string> {
		const serializedTx = signedTx.serialize();
		const base64Tx = Buffer.from(serializedTx).toString("base64");
		
		// Use the same submission logic as the regular deposit function
		const response = await fetchWithRetry(
			`${this.relayerUrl}/deposit`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					signedTransaction: base64Tx,
				}),
			},
			3,
		);

		if (!response.ok) {
			let errorMsg: string;
			try {
				const errorData = (await response.json()) as {
					error?: any;
				};
				errorMsg = errorData.error || `HTTP ${response.status}`;
			} catch {
				errorMsg = `HTTP ${response.status}`;
			}
			throw new Error(`Failed to submit deposit transaction: ${errorMsg}`);
		}

		const data = (await response.json()) as { txid: string };
		return data.txid;
	}

	/**
	 * Submit a built SPL deposit transaction
	 * (Internal helper method)
	 */
	private async submitSplDepositTransaction(signedTx: VersionedTransaction): Promise<string> {
		const serializedTx = signedTx.serialize();
		const base64Tx = Buffer.from(serializedTx).toString("base64");
		
		// Use the SPL deposit endpoint
		const response = await fetchWithRetry(
			`${this.relayerUrl}/deposit/spl`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					signedTransaction: base64Tx,
				}),
			},
			3,
		);

		if (!response.ok) {
			let errorMsg: string;
			try {
				const errorData = (await response.json()) as {
					error?: any;
				};
				errorMsg = errorData.error || `HTTP ${response.status}`;
			} catch {
				errorMsg = `HTTP ${response.status}`;
			}
			throw new Error(`Failed to submit SPL deposit transaction: ${errorMsg}`);
		}

		const data = (await response.json()) as { txid: string };
		return data.txid;
	}

	/**
	 * Batch withdraw SOL from the privacy pool when multiple UTXOs (>2) are needed
	 *
	 * This method optimizes withdrawals that require more than 2 UTXOs by building
	 * all necessary transactions upfront and signing them with a single wallet popup
	 * using signAllTransactions.
	 *
	 * @param options - Batch withdraw options
	 * @returns Promise resolving to batch withdraw result
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.batchWithdrawSol({
	 *   recipientAddress: 'recipient-pubkey-string',
	 *   amount: 10.5, // May require multiple transactions
	 *   onStatus: (status) => console.log('Status:', status)
	 * });
	 *
	 * console.log(`Withdrew in ${result.signatures.length} transactions`);
	 * ```
	 */
	async batchWithdrawSol(options: BatchWithdrawOptions): Promise<BatchWithdrawResult> {
		this.ensureInitialized();

		try {
			const recipientPubkey =
				typeof options.recipientAddress === "string"
					? new PublicKey(options.recipientAddress)
					: options.recipientAddress;

			log(`Batch withdrawing ${options.amount} SOL...`);

			// Get available UTXOs
			const allUtxos = await getMyUtxos(
				options.utxoWalletSigned || this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
			);

			// Filter for SOL UTXOs
			const solUtxos = allUtxos.filter(
				(utxo) =>
					utxo.mintAddress === "11111111111111111111111111111112" &&
					utxo.amount.gt(new BN(0)),
			);

			// Check if UTXOs are unspent
			const { isUtxoSpent } = await import("../utils/getMyUtxos");
			const utxoSpentStatuses = await Promise.all(
				solUtxos.map((utxo) => isUtxoSpent(this.connection, utxo)),
			);
			const unspentUtxos = solUtxos.filter((_, index) => !utxoSpentStatuses[index]);

			if (unspentUtxos.length < 1) {
				throw new Error("Need at least 1 unspent UTXO to perform a withdrawal");
			}

			// Sort by amount descending
			unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

			// Plan the batch withdrawals
			const { planBatchWithdrawals } = await import("../utils/batch-withdraw");
			const { LAMPORTS_PER_SOL } = await import("@solana/web3.js");
			const { WITHDRAW_FEE_RATE } = await import("../utils/constants");

			const amountLamports = options.amount * LAMPORTS_PER_SOL;
			const plan = planBatchWithdrawals(amountLamports, WITHDRAW_FEE_RATE, unspentUtxos);

			if (!plan || plan.withdrawals.length === 0) {
				throw new Error("Unable to plan batch withdrawals with available UTXOs");
			}

			log(`Planned ${plan.withdrawals.length} withdrawals`);
			options.onStatus?.(`Planning ${plan.withdrawals.length} withdrawals...`);

			// Submit all transactions
			options.onStatus?.('Submitting transactions...');
			const signatures: string[] = [];
			let successCount = 0;
			let isPartial = false;

			for (let i = 0; i < plan.withdrawals.length; i++) {
				const withdrawal = plan.withdrawals[i];
				const amountInSol = withdrawal.amount / LAMPORTS_PER_SOL;
				const progress = `[${i + 1}/${plan.withdrawals.length}]`;

				try {
					options.onStatus?.(`Submitting ${i + 1}/${plan.withdrawals.length} transactions...`);
					log(`${progress} Submitting ${amountInSol} SOL withdrawal...`);

					// Use the existing withdraw function with specific UTXOs
					const result = await withdraw(
						recipientPubkey,
						amountInSol,
						this.signed!,
						this.connection,
						undefined,
						this.hasher,
						options.delayMinutes,
						options.maxRetries ?? 3,
						0, // retryCount
						options.utxoWalletSigned,
						options.utxoWalletSignTransaction,
						withdrawal.utxos, // Provide specific UTXOs for this withdrawal
						this.relayerUrl,
						this.circuitPath,
					);

					if (result.success && result.signature) {
						signatures.push(result.signature);
						successCount++;
						if (result.isPartial) {
							isPartial = true;
						}
						log(`${progress} Transaction submitted: ${result.signature}`);
					}

					// Small delay between submissions for backend processing
					if (i < plan.withdrawals.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				} catch (err) {
					error(`${progress} Failed to submit: ${err}`);
					// Continue with remaining transactions
				}
			}

			// Refresh UTXOs
			options.onStatus?.('Refreshing UTXOs...');
			await this.refreshUtxos();

			log(`Batch withdrawal complete: ${successCount}/${plan.withdrawals.length} successful`);

			return {
				success: successCount > 0,
				signatures,
				successCount,
				totalCount: plan.withdrawals.length,
				isPartial,
				error: successCount < plan.withdrawals.length ? `Only ${successCount}/${plan.withdrawals.length} withdrawals succeeded` : undefined
			};

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log(`Batch withdrawal failed: ${errorMessage}`);
			return {
				success: false,
				signatures: [],
				successCount: 0,
				totalCount: 0,
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
				this.relayerUrl,
				this.circuitPath,
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
	 * Batch withdraw SPL tokens from the privacy pool when multiple UTXOs (>2) are needed
	 *
	 * This method optimizes SPL token withdrawals that require more than 2 UTXOs by
	 * planning all necessary transactions upfront for better coordination.
	 *
	 * @param options - Batch SPL withdraw options
	 * @returns Promise resolving to batch withdraw result
	 *
	 * @example
	 * ```typescript
	 * const result = await sdk.batchWithdrawSpl({
	 *   recipientAddress: 'recipient-pubkey-string',
	 *   amount: 1000000, // May require multiple transactions
	 *   mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	 *   onStatus: (status) => console.log('Status:', status)
	 * });
	 *
	 * console.log(`Withdrew in ${result.signatures.length} transactions`);
	 * ```
	 */
	async batchWithdrawSpl(options: BatchWithdrawSplOptions): Promise<BatchWithdrawResult> {
		this.ensureInitialized();

		try {
			const recipientPubkey =
				typeof options.recipientAddress === "string"
					? new PublicKey(options.recipientAddress)
					: options.recipientAddress;

			log(`Batch withdrawing SPL tokens (${options.mintAddress})...`);

			// Convert mint address to numeric format for filtering
			const mint = new PublicKey(options.mintAddress);
			const mintBytes = mint.toBytes();
			const mintBN = new BN(mintBytes);
			const FIELD_SIZE = new BN(
				"21888242871839275222246405745257275088548364400416034343698204186575808495617",
			);
			const mintAddressNumeric = mintBN.mod(FIELD_SIZE).toString();

			// Get available UTXOs
			const allUtxos = await getMyUtxos(
				options.utxoWalletSigned || this.signed!,
				this.connection,
				options.onStatus,
				this.hasher,
			);

			// Filter for this specific mint's UTXOs
			const mintUtxos = allUtxos.filter(
				(utxo) =>
					utxo.mintAddress === mintAddressNumeric &&
					utxo.amount.gt(new BN(0)),
			);

			// Check if UTXOs are unspent
			const { isUtxoSpent } = await import("../utils/getMyUtxos");
			const utxoSpentStatuses = await Promise.all(
				mintUtxos.map((utxo) => isUtxoSpent(this.connection, utxo)),
			);
			const unspentUtxos = mintUtxos.filter((_, index) => !utxoSpentStatuses[index]);

			if (unspentUtxos.length < 1) {
				throw new Error("Need at least 1 unspent UTXO to perform a withdrawal");
			}

			// Sort by amount descending
			unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

			// Plan the batch withdrawals
			const { planBatchWithdrawals } = await import("../utils/batch-withdraw");
			const { WITHDRAW_FEE_RATE } = await import("../utils/constants");

			const plan = planBatchWithdrawals(options.amount, WITHDRAW_FEE_RATE, unspentUtxos);

			if (!plan || plan.withdrawals.length === 0) {
				throw new Error("Unable to plan batch withdrawals with available UTXOs");
			}

			log(`Planned ${plan.withdrawals.length} withdrawals`);
			options.onStatus?.(`Planning ${plan.withdrawals.length} withdrawals...`);

			// Submit all transactions
			options.onStatus?.('Submitting transactions...');
			const signatures: string[] = [];
			let successCount = 0;
			let isPartial = false;

			for (let i = 0; i < plan.withdrawals.length; i++) {
				const withdrawal = plan.withdrawals[i];
				const progress = `[${i + 1}/${plan.withdrawals.length}]`;

				try {
					options.onStatus?.(`Submitting ${i + 1}/${plan.withdrawals.length} transactions...`);
					log(`${progress} Submitting ${withdrawal.amount} token withdrawal...`);

					// Use the existing withdrawSpl function with specific UTXOs
					const result = await withdrawSpl(
						recipientPubkey,
						withdrawal.amount,
						options.mintAddress,
						this.signed!,
						this.connection,
						undefined,
						this.hasher,
						options.delayMinutes,
						options.maxRetries ?? 3,
						0, // retryCount
						options.utxoWalletSigned,
						options.utxoWalletSignTransaction,
						withdrawal.utxos, // Provide specific UTXOs for this withdrawal
						this.relayerUrl,
						this.circuitPath,
					);

					if (result.success && result.signature) {
						signatures.push(result.signature);
						successCount++;
						if (result.isPartial) {
							isPartial = true;
						}
						log(`${progress} Transaction submitted: ${result.signature}`);
					}

					// Small delay between submissions for backend processing
					if (i < plan.withdrawals.length - 1) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				} catch (err) {
					error(`${progress} Failed to submit: ${err}`);
					// Continue with remaining transactions
				}
			}

			// Refresh UTXOs
			options.onStatus?.('Refreshing UTXOs...');
			await this.refreshUtxos();

			log(`Batch withdrawal complete: ${successCount}/${plan.withdrawals.length} successful`);

			return {
				success: successCount > 0,
				signatures,
				successCount,
				totalCount: plan.withdrawals.length,
				isPartial,
				error: successCount < plan.withdrawals.length ? `Only ${successCount}/${plan.withdrawals.length} withdrawals succeeded` : undefined
			};

		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			log(`Batch withdrawal failed: ${errorMessage}`);
			return {
				success: false,
				signatures: [],
				successCount: 0,
				totalCount: 0,
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
				this.relayerUrl,
				this.circuitPath,
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
				`${this.relayerUrl}/merkle/root`,
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
