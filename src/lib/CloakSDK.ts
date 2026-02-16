import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
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
import { Utxo } from "../models/utxo";
import type {
	CloakSDKConfig,
	TransactionSigner,
	DepositOptions,
	DepositSplOptions,
	BatchDepositOptions,
	BatchDepositSplOptions,
	WithdrawOptions,
	WithdrawSplOptions,
	DepositResult,
	BatchDepositResult,
	WithdrawResult,
	Signed,
	UtxoBalance,
	TransferOptions,
	TransferResult,
	TransferBackOptions,
	TransferBackResult,
	BatchBalanceEntry,
	MaxTransferableOptions,
	MaxTransferableResult,
	LightWasm,
} from "../types";
import { getMyUtxos, clearUtxoCache, refreshUtxos } from "../utils/getMyUtxos";
import { planBatchDeposits, planBatchSplDeposits } from "../utils/batch-deposit";
import { ErrorCodes, ConfigurationError, isCloakError } from "../errors";
import { fetchWithRetry } from "../utils/fetchWithRetry";
import {
	CIRCUIT_PATH,
	WITHDRAW_FEE_RATE,
} from "../utils/constants";
import { mintIdMatches } from "../utils/spl-mint-id";
import {
	DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS,
	computeMaxTransferableLamports,
	solToLamportsNonNegative,
} from "../utils/max-transferable";

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
 * Helper to check if signer is a Keypair
 */
function isKeypair(
	signer: TransactionSigner | Keypair | null | undefined,
): signer is Keypair {
	return !!signer && "secretKey" in signer;
}

export class CloakSDK {
	private connection: Connection;
	private signer: TransactionSigner | Keypair | null;
	private publicKey: PublicKey | null;
	private relayerUrl: string;
	private programId: string;
	private verbose: boolean;
	private circuitPath: string;
	private altAddress: PublicKey;
	private hasher: LightWasm | null = null;
	private initialized: boolean = false;
	private lastKnownTreeIndex: number = -1;
	private lastTreeStateCheckAtMs: number = 0;
	private readonly treeStateCheckIntervalMs: number = 2_000;
	private readonly accountSignCache = new Map<string, Signed>();

	/**
	 * Creates a new Cloak SDK instance
	 *
	 * @param config - SDK configuration
	 */
	constructor(config: CloakSDKConfig) {
		this.connection = config.connection;
		this.signer = null;
		this.publicKey = null;
		this.relayerUrl = config.relayerUrl;
		this.programId =
			config.programId ||
			"8wbkRNdUfjsL3hJotuHX9innLPAdChJ5qGYG41Htpmuk";
		this.verbose = config.verbose || false;
		this.circuitPath = config.circuitPath || CIRCUIT_PATH;
		this.altAddress = typeof config.altAddress === 'string'
			? new PublicKey(config.altAddress)
			: config.altAddress;

		// Set global verbose mode for logger
		setVerbose(this.verbose);
	}

	/**
	 * Initialize the SDK
	 *
	 * This must be called before operations.
	 * It loads the Poseidon hasher.
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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);

				const result = await deposit(
					options.amount,
					signed,
					this.connection,
					this.relayerUrl,
					options.onStatus,
					this.hasher!,
					(tx) => this.signTransaction(tx, signer),
					options.maxRetries ?? 3,
					0, // retryCount,
					options.utxoWalletSigned,
					options.utxoWalletSignTransaction,
					this.circuitPath,
					undefined, // transactionIndex
					!options.consolidate, // forceFreshDeposit
					undefined, // buildOnly
					this.altAddress,
				);

			if (result.success) {
				log(`Deposit successful: ${result.signature}`);
			}

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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);

				const result = await depositSpl(
					options.amount,
					options.mintAddress,
					signed,
					this.connection,
					this.relayerUrl,
					options.onStatus,
					this.hasher!,
					(tx) => this.signTransaction(tx, signer),
					options.maxRetries ?? 3,
					0, // retryCount
					options.utxoWalletSigned,
					options.utxoWalletSignTransaction,
					this.circuitPath,
					this.altAddress,
					!options.consolidate,
				);

			if (result.success) {
				log(
					`SPL deposit successful: ${result.signature}`,
				);
			}

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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);

			// Plan the batch deposit
			const plan = planBatchDeposits(options.amount);
			if (!plan) {
				throw new Error(`Amount ${options.amount} too small for batch deposit`);
			}

			log(`Planned ${plan.totalDeposits} deposits: ${plan.deposits.map(d => d.amount).join(', ')} SOL`);
			options.onStatus?.(`Planning ${plan.totalDeposits} deposits...`);

			// Check if signAllTransactions is available
			const signAllTxs = 'signAllTransactions' in signer ? signer.signAllTransactions : undefined;
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
							signer,
							signed,
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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);

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
			const signAllTxs = 'signAllTransactions' in signer ? signer.signAllTransactions : undefined;
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
							signer,
							signed,
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
		signer?: TransactionSigner | Keypair,
		signed?: Signed,
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
					signed ?? utxoWalletSigned ?? (await this.resolveSigned(signer)),
					this.connection,
					this.relayerUrl,
					onStatus,
					this.hasher!,
					captureTransaction, // Intercept the transaction
					1, // maxRetries
					0, // retryCount
					utxoWalletSigned,
				utxoWalletSignTransaction,
				this.circuitPath,
				transactionIndex, // Pass transaction index for unique dummy UTXOs in batch deposits
				true, // forceFreshDeposit: Skip UTXO fetching for batch deposits to avoid conflicts
				true, // buildOnly: Only build the transaction, don't submit it
				this.altAddress,
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
		signer?: TransactionSigner | Keypair,
		signed?: Signed,
		_transactionIndex?: number,
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
					signed ?? utxoWalletSigned ?? (await this.resolveSigned(signer)),
					this.connection,
					this.relayerUrl,
					onStatus,
					this.hasher!,
					captureTransaction, // Intercept the transaction
					1, // maxRetries
					0, // retryCount
					utxoWalletSigned,
					utxoWalletSignTransaction,
					this.circuitPath,
					this.altAddress,
					true, // forceFreshDeposit (batch builds should not consolidate)
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
						error?: unknown;
					};
					errorMsg =
						typeof errorData.error === "string"
							? errorData.error
							: `HTTP ${response.status}`;
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
						error?: unknown;
					};
					errorMsg =
						typeof errorData.error === "string"
							? errorData.error
							: `HTTP ${response.status}`;
				} catch {
					errorMsg = `HTTP ${response.status}`;
				}
			throw new Error(`Failed to submit SPL deposit transaction: ${errorMsg}`);
		}

		const data = (await response.json()) as { txid: string };
		return data.txid;
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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);
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
					signed,
					this.connection,
					this.relayerUrl,
					options.onStatus,
					this.hasher!,
					options.delayMinutes,
					options.maxRetries ?? 3,
					0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
				options.providedUtxos,
				this.circuitPath,
				this.altAddress,
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

			return result;
		} catch (err) {
			const errorMessage =
				err instanceof Error
					? err.message
					: String(err);
			log(`Withdrawal failed: ${errorMessage}`);

			let maxWithdrawableLamports: string | undefined;
			let maxWithdrawableAmount: number | undefined;
			if (isCloakError(err)) {
				const details = err.details as Record<string, unknown> | undefined;
				if (details && typeof details.maxWithdrawableLamports === "string") {
					maxWithdrawableLamports = details.maxWithdrawableLamports;
					try {
						maxWithdrawableAmount = this.lamportsToSol(
							BigInt(maxWithdrawableLamports),
						);
					} catch {
						// Ignore conversion issues (extremely large values)
					}
				}
			}

			return {
				isPartial: false,
				success: false,
				error: errorMessage,
				maxWithdrawableAmount,
				maxWithdrawableLamports,
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
			const signer = this.resolveSigner(options.signer);
			const signed = await this.resolveSigned(signer);
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
					signed,
					this.connection,
					this.relayerUrl,
					options.onStatus,
					this.hasher!,
					options.delayMinutes,
					options.maxRetries ?? 3,
					0, // retryCount
				options.utxoWalletSigned,
				options.utxoWalletSignTransaction,
				options.providedUtxos,
				this.circuitPath,
				this.altAddress,
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
		const defaultRecipient = this.requirePublicKey(
			"fullTransfer requires a signer when recipientAddress is not provided.",
		);
		const recipientPubkey = options.recipientAddress
			? typeof options.recipientAddress === "string"
				? new PublicKey(options.recipientAddress)
				: options.recipientAddress
			: defaultRecipient;

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
	 * Transfer SOL from one or more source keypairs to destination keypairs.
	 *
	 * It uses `withdrawSol` under the hood, sourcing balance from `in` keypairs
	 * and splitting destination amounts by BPS (`bps`) or equally when omitted.
	 */
	async transfer(options: TransferOptions): Promise<TransferResult> {
		this.ensureInitialized();

		try {
			const onStatus = options.onStatus || (() => {});
			this.validateTransferOptions(options);
			const requestedLamports = this.solToLamports(options.amount);

				const sourceStates = await Promise.all(
					options.in.map(async (sourceKeypair) => {
						const signed = await getAccountSign(sourceKeypair);
						const balance = await this.getSolBalance(signed, true);
						const remainingLamports = BigInt(balance.total.toString());
						return {
							signer: sourceKeypair,
							signed,
							publicKey: sourceKeypair.publicKey.toBase58(),
							remainingLamports,
						};
					}),
				);

			const totalAvailableLamports = sourceStates.reduce(
				(sum, source) => sum + source.remainingLamports,
				0n,
			);

			if (totalAvailableLamports <= 0n) {
				return {
					success: false,
					requestedAmount: options.amount,
					attemptedAmount: 0,
					legs: [],
					error: "No balance available in source keypairs",
				};
			}

			const attemptedLamports =
				requestedLamports < totalAvailableLamports
					? requestedLamports
					: totalAvailableLamports;
			const attemptedAmount = this.lamportsToSol(attemptedLamports);
			const destinationAllocations = this.buildDestinationAllocationsLamports(
				options.out,
				attemptedLamports,
				options.bps,
			);

			const legs: TransferResult["legs"] = [];
			let sourceIndex = 0;
			let transferredLamports = 0n;

			for (const allocation of destinationAllocations) {
				let remainingForDestinationLamports = allocation.amountLamports;
				if (remainingForDestinationLamports <= 0n) {
					continue;
				}

				onStatus(
					`Transferring ${this.lamportsToSol(remainingForDestinationLamports)} SOL to ${allocation.destination.toBase58()}`,
				);

				while (
					remainingForDestinationLamports > 0n &&
					sourceIndex < sourceStates.length
				) {
					const source = sourceStates[sourceIndex];
					// Always re-check fresh balance for the source wallet we're transferring FROM.
					const refreshedSourceBalance = await this.getSolBalance(
						source.signed,
						true,
					);
					source.remainingLamports = BigInt(
						refreshedSourceBalance.total.toString(),
					);

					if (source.remainingLamports <= 0n) {
						sourceIndex++;
						continue;
					}

					const legLamports =
						source.remainingLamports <
						remainingForDestinationLamports
							? source.remainingLamports
							: remainingForDestinationLamports;
					const sourceLamportsBeforeWithdrawal =
						source.remainingLamports;

					if (legLamports <= 0n) {
						sourceIndex++;
						continue;
					}

						const result = await this.withdrawSol({
							recipientAddress: allocation.destination,
							amount: this.lamportsToSol(legLamports),
							delayMinutes: options.delay,
							maxRetries: options.maxRetries,
							signer: source.signer,
							utxoWalletSigned: source.signed,
							onStatus: (status) =>
								onStatus(
									`[${source.publicKey} -> ${allocation.destination.toBase58()}] ${status}`,
								),
						});

					legs.push({
						from: source.publicKey,
						to: allocation.destination.toBase58(),
						requestedAmount: this.lamportsToSol(legLamports),
						result,
					});

					if (result.success) {
						source.remainingLamports -= legLamports;
						remainingForDestinationLamports -= legLamports;
						transferredLamports += legLamports;

						// Wait for source-wallet UTXO state to update before using it again.
						// Skip this for delayed withdrawals because UTXO updates are not immediate.
						if ((options.delay ?? 0) === 0) {
							const utxoUpdate = await this.waitForSourceUtxoStateChange(
								source.signed,
								sourceLamportsBeforeWithdrawal,
								onStatus,
							);
							if (utxoUpdate.updatedLamports !== null) {
								source.remainingLamports = utxoUpdate.updatedLamports;
							}
						}
					} else {
						sourceIndex++;
					}
				}
			}

			const allLegsSucceeded =
				legs.length > 0 &&
				legs.every((leg) => leg.result.success === true);
			const fullyTransferred =
				transferredLamports === attemptedLamports;

			return {
				success: allLegsSucceeded && fullyTransferred,
				requestedAmount: options.amount,
				attemptedAmount,
				legs,
				error:
					legs.length === 0
						? "No transfer legs were executed"
						: !fullyTransferred
							? `Transfer incomplete: ${this.lamportsToSol(attemptedLamports - transferredLamports)} SOL could not be transferred`
							: undefined,
			};
		} catch (err) {
			return {
				success: false,
				requestedAmount: options.amount,
				attemptedAmount: 0,
				legs: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async waitForSourceUtxoStateChange(
		signed: Signed,
		previousLamports: bigint,
		onStatus?: (status: string) => void,
		timeoutMs: number = 20_000,
		pollMs: number = 1_200,
	): Promise<{ updatedLamports: bigint | null }> {
		const startedAt = Date.now();
		let lastSeenLamports: bigint | null = previousLamports;

		while (Date.now() - startedAt < timeoutMs) {
			try {
				const balance = await this.getSolBalance(signed, true);
				const currentLamports = BigInt(balance.total.toString());
				if (currentLamports !== previousLamports) {
					onStatus?.(
						`[UTXO check] Source UTXO state changed (${this.lamportsToSol(previousLamports)} -> ${this.lamportsToSol(currentLamports)} SOL).`,
					);
					return { updatedLamports: currentLamports };
				}
				lastSeenLamports = currentLamports;
			} catch {
				// Keep polling through transient RPC/relayer failures.
			}

			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}

		onStatus?.(
			"[UTXO check] Timed out waiting for source UTXO update; continuing.",
		);
		return { updatedLamports: lastSeenLamports };
	}

	/**
	 * Transfer all available SOL back to the SDK signer wallet for each keypair
	 * and best-effort cancel pending delayed withdrawals at the relayer.
	 */
	async transferBack(
		keyPairs: Keypair[],
		options: TransferBackOptions = {},
	): Promise<TransferBackResult> {
		this.ensureInitialized();

		try {
			if (!keyPairs?.length) {
				throw new Error("transferBack requires at least one keypair");
			}
			const onStatus = options.onStatus || (() => {});
			const recipient = this.requirePublicKey(
				"transferBack requires an SDK signer as the destination wallet.",
			);

			const entries: TransferBackResult["entries"] = [];
			let transferredBackLamports = 0n;

			for (const keypair of keyPairs) {
				const signed = await getAccountSign(keypair);
				onStatus(
					`[transferBack] processing ${keypair.publicKey.toBase58()}`,
				);
				const cancellation = await this.cancelPendingDelayedWithdrawals(signed);
				const maxTransferable = await this.getMaxTransferableAmount({
					numberOfWithdrawals: 1,
					signer: keypair,
					utxoWalletSigned: signed,
					forceRefresh: true,
				});
				const balanceLamports = maxTransferable.availableLamports;

					let withdrawResult: WithdrawResult | undefined;
					if (maxTransferable.maxTransferableAmount > 0) {
						withdrawResult = await this.withdrawSol({
							recipientAddress: recipient,
							amount: maxTransferable.maxTransferableAmount,
							signer: keypair,
							utxoWalletSigned: signed,
							delayMinutes: 0,
							onStatus: (status) =>
								onStatus(
									`[transferBack:${keypair.publicKey.toBase58()}] ${status}`,
								),
						});
						if (withdrawResult.success) {
							transferredBackLamports += BigInt(
								maxTransferable.maxTransferableLamports,
							);
						}
					}

				entries.push({
					from: keypair.publicKey.toBase58(),
					canceledPending: cancellation.canceledPending,
					cancelWarnings:
						cancellation.warnings.length > 0
							? cancellation.warnings
							: undefined,
					balanceLamports,
					maxTransferableAmount:
						maxTransferable.maxTransferableAmount,
					maxTransferableLamports:
						maxTransferable.maxTransferableLamports,
					withdrawResult,
				});
			}

			const transferBackSuccess = entries.every(
				(entry) => !entry.withdrawResult || entry.withdrawResult.success === true,
			);
			const transferredBackAmount =
				this.lamportsToSol(transferredBackLamports);
			let redepositResult: DepositResult | undefined;
			if (
				options.redepositToPool &&
				transferredBackLamports > 0n
			) {
				onStatus(
					`[transferBack] redepositing ${transferredBackAmount} SOL into Cloak pool...`,
				);
				redepositResult = await this.depositSol({
					amount: transferredBackAmount,
					onStatus: (status) =>
						onStatus(`[transferBack:redeposit] ${status}`),
				});
			}
			const success =
				transferBackSuccess &&
				(!redepositResult || redepositResult.success);

			return {
				success,
				entries,
				transferredBackAmount,
				redepositResult,
			};
		} catch (err) {
			return {
				success: false,
				entries: [],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Check SOL balances for many keypairs in one call.
	 */
	async batchBalanceCheck(keyPairs: Keypair[]): Promise<BatchBalanceEntry[]> {
		this.ensureInitialized();
		return await Promise.all(
			keyPairs.map(async (keypair) => {
				const signed = await getAccountSign(keypair);
				const balance = await this.getSolBalance(signed, true);
				return {
					publicKey: keypair.publicKey.toBase58(),
					balance,
				};
			}),
		);
	}

	/**
	 * Estimate the maximum transferable SOL recipient amount from private balance
	 * for a planned number of withdrawals.
	 *
	 * This accounts for:
	 * - Variable withdraw fee rate (default protocol fee: 0.3%)
	 * - Fixed per-withdrawal cost (default: 2 * 0.00095352 SOL)
	 */
	async getMaxTransferableAmount(
		options: MaxTransferableOptions = {},
	): Promise<MaxTransferableResult> {
		this.ensureInitialized();

		const numberOfWithdrawals = options.numberOfWithdrawals ?? 1;
		const withdrawFeeRatePercent =
			options.withdrawFeeRatePercent ?? WITHDRAW_FEE_RATE;
		const fixedCostPerWithdrawalLamports =
			options.fixedCostPerWithdrawalSol !== undefined
				? solToLamportsNonNegative(
						options.fixedCostPerWithdrawalSol,
					)
				: DEFAULT_FIXED_WITHDRAWAL_COST_LAMPORTS;

		const balance = await this.getSolBalance(
			options.utxoWalletSigned,
			options.forceRefresh ?? true,
			options.signer,
		);
		const availableLamports = BigInt(balance.total.toString());

		const computed = computeMaxTransferableLamports({
			availableLamports,
			numberOfWithdrawals,
			withdrawFeeRatePercent,
			fixedCostPerWithdrawalLamports,
		});

		return {
			maxTransferableAmount: this.lamportsToSol(
				computed.maxTransferableLamports,
			),
			maxTransferableLamports:
				computed.maxTransferableLamports.toString(),
			availableAmount: this.lamportsToSol(
				computed.availableLamports,
			),
			availableLamports: computed.availableLamports.toString(),
			numberOfWithdrawals:
				computed.numberOfWithdrawals,
			withdrawFeeRatePercent:
				computed.withdrawFeeRatePercent,
			fixedCostPerWithdrawalSol:
				this.lamportsToSol(
					computed.fixedCostPerWithdrawalLamports,
				),
			totalFixedCostSol: this.lamportsToSol(
				computed.totalFixedCostLamports,
			),
			totalFixedCostLamports:
				computed.totalFixedCostLamports.toString(),
			estimatedVariableFeeSol:
				this.lamportsToSol(
					computed.variableFeeAtMaxLamports,
				),
			estimatedVariableFeeLamports:
				computed.variableFeeAtMaxLamports.toString(),
			estimatedTotalFeeSol:
				this.lamportsToSol(
					computed.totalFeeAtMaxLamports,
				),
			estimatedTotalFeeLamports:
				computed.totalFeeAtMaxLamports.toString(),
		};
	}

	/**
	 * Backward-compatible alias for misspelled method name.
	 */
	async getMaxTransferrableAmount(
		options: MaxTransferableOptions = {},
	): Promise<MaxTransferableResult> {
		return await this.getMaxTransferableAmount(options);
	}

	private validateTransferOptions(options: TransferOptions): void {
		if (!options.in?.length) {
			throw new Error("transfer requires at least one source keypair in `in`");
		}
		if (!options.out?.length) {
			throw new Error("transfer requires at least one destination keypair in `out`");
		}
		if (!Number.isFinite(options.amount) || options.amount <= 0) {
			throw new Error("transfer `amount` must be a positive number");
		}
		if (
			options.delay !== undefined &&
			(!Number.isFinite(options.delay) || options.delay < 0)
		) {
			throw new Error("transfer `delay` must be a non-negative number of minutes");
		}
		if (
			options.delay !== undefined &&
			!Number.isInteger(options.delay)
		) {
			throw new Error("transfer `delay` must be an integer number of minutes");
		}
		if (
			options.delay !== undefined &&
			options.delay > 10080
		) {
			throw new Error("transfer `delay` cannot exceed 10080 minutes (7 days)");
		}
	}

	private resolveWalletKey(wallet: Keypair | PublicKey | string): string {
		if (typeof wallet === "string") {
			return wallet;
		}
		if (wallet instanceof Keypair) {
			return wallet.publicKey.toBase58();
		}
		return wallet.toBase58();
	}

	private getDestinationBps(
		bpsMap: Map<Keypair | PublicKey | string, number> | undefined,
		destination: Keypair,
	): number {
		if (!bpsMap || bpsMap.size === 0) {
			return 0;
		}
		const destinationKey = destination.publicKey.toBase58();
		for (const [wallet, bps] of bpsMap.entries()) {
			if (this.resolveWalletKey(wallet) === destinationKey) {
				return Math.max(0, bps);
			}
		}
		return 0;
	}

	private buildDestinationAllocationsLamports(
		destinations: Keypair[],
		totalAmountLamports: bigint,
		bpsMap?: Map<Keypair | PublicKey | string, number>,
	): { destination: PublicKey; amountLamports: bigint }[] {
		const destinationBps = destinations.map((destination) =>
			this.getDestinationBps(bpsMap, destination),
		);
		const hasPositiveBps = destinationBps.some((bps) => bps > 0);
		const weights = hasPositiveBps
			? destinationBps.map((bps) => Math.max(0, Math.floor(bps)))
			: destinations.map(() => 1);
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		const safeTotalWeight = totalWeight > 0 ? totalWeight : destinations.length;

		const allocations = destinations.map((destination, index) => {
			const weight = BigInt(weights[index]);
			const amountLamports =
				(totalAmountLamports * weight) / BigInt(safeTotalWeight);
			return {
				destination: destination.publicKey,
				amountLamports,
			};
		});

		let allocatedLamports = allocations.reduce(
			(sum, allocation) => sum + allocation.amountLamports,
			0n,
		);
		let remainder = totalAmountLamports - allocatedLamports;

		if (remainder > 0n) {
			for (let i = 0; i < allocations.length && remainder > 0n; i++) {
				if (weights[i] <= 0) {
					continue;
				}
				allocations[i].amountLamports += 1n;
				allocatedLamports += 1n;
				remainder -= 1n;
			}
		}

		return allocations;
	}

	private solToLamports(amount: number): bigint {
		const lamports = Math.round(amount * LAMPORTS_PER_SOL);
		if (!Number.isFinite(lamports) || lamports <= 0) {
			throw new Error("transfer `amount` is too small after lamport conversion");
		}
		return BigInt(lamports);
	}

	private lamportsToSol(amountLamports: bigint): number {
		const isNegative = amountLamports < 0n;
		const absoluteLamports = isNegative
			? (amountLamports * -1n).toString()
			: amountLamports.toString();
		const padded = absoluteLamports.padStart(10, "0");
		const whole = padded.slice(0, -9);
		const fraction = padded.slice(-9).replace(/0+$/, "");
		const solString = fraction
			? `${whole}.${fraction}`
			: whole;
		const value = Number(solString);
		if (!Number.isFinite(value)) {
			throw new Error("Lamport value is too large to convert to number");
		}
		return isNegative ? -value : value;
	}

	private async cancelPendingDelayedWithdrawals(
		signed: Signed,
	): Promise<{ canceledPending: number; warnings: string[] }> {
		const warnings: string[] = [];
		const payload = {
			publicKey: signed.publicKey.toBase58(),
			signature: Buffer.from(signed.signature).toString("base64"),
		};

		const endpoints = [
			"/withdraw/delayed/cancel/all",
			"/withdraw/delayed/cancel",
			"/withdraw/cancel-pending",
		];

		for (const endpoint of endpoints) {
			try {
				const response = await fetchWithRetry(
					`${this.relayerUrl}${endpoint}`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify(payload),
					},
					1,
				);

				if (!response.ok) {
					warnings.push(`${endpoint} returned HTTP ${response.status}`);
					continue;
				}

				const data = (await response.json()) as {
					canceled?: number;
					cancelled?: number;
					count?: number;
				};

				return {
					canceledPending: Number(
						data.canceled ?? data.cancelled ?? data.count ?? 0,
					),
					warnings,
				};
			} catch (err) {
				warnings.push(
					`${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return { canceledPending: 0, warnings };
	}

	/**
	 * Query the current tree state and check if it has changed
	 * If changed, triggers UTXO cache refresh
	 */
	private async checkAndRefreshTreeState(): Promise<void> {
		const now = Date.now();
		if (
			now - this.lastTreeStateCheckAtMs <
			this.treeStateCheckIntervalMs
		) {
			return;
		}

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
		} finally {
			this.lastTreeStateCheckAtMs = now;
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
	async getSolBalance(
		utxoWalletSigned?: Signed,
		forceRefresh: boolean = false,
		signer?: TransactionSigner | Keypair,
	): Promise<UtxoBalance> {
		this.ensureInitialized();

		try {
			const signed = await this.resolveSigned(signer, utxoWalletSigned);
			// Check if tree state has changed before fetching UTXOs
			await this.checkAndRefreshTreeState();

			const utxos = await getMyUtxos(
				signed,
				this.connection,
				this.relayerUrl,
				undefined,
				this.hasher!,
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
		signer?: TransactionSigner | Keypair,
	): Promise<UtxoBalance> {
		this.ensureInitialized();

		try {
			const signed = await this.resolveSigned(signer, utxoWalletSigned);
			// Check if tree state has changed before fetching UTXOs
			await this.checkAndRefreshTreeState();

			const utxos = await getMyUtxos(
				signed,
				this.connection,
				this.relayerUrl,
				undefined,
				this.hasher!,
				forceRefresh,
			);

			// Filter for this specific mint using backwards-compatible matching
			const tokenUtxos = utxos.filter(
				(utxo) =>
					mintIdMatches(utxo.mintAddress, mintAddress) &&
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
				mintAddress: mintAddress,
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
		return this.requirePublicKey(
			"No signer configured for this SDK instance.",
		);
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
	async refreshUtxos(): Promise<Utxo[]> {
		if (!this.hasher) {
			throw new ConfigurationError(
				ErrorCodes.NOT_INITIALIZED,
				"SDK not initialized. Call initialize() first.",
			);
		}
		const signed = await this.resolveSigned();
		return await refreshUtxos(
			signed,
			this.connection,
			this.relayerUrl,
			undefined,
			this.hasher!,
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
	 * Set or replace the SDK signer after initialization.
	 */
	setSigner(signer: TransactionSigner | Keypair): void {
		this.signer = signer;
		this.publicKey = signer.publicKey;
	}

	/**
	 * Clear the currently configured signer.
	 */
	clearSigner(): void {
		this.signer = null;
		this.publicKey = null;
		this.accountSignCache.clear();
	}

	private requirePublicKey(errorMessage: string): PublicKey {
		if (!this.publicKey) {
			throw new ConfigurationError(
				ErrorCodes.INVALID_CONFIGURATION,
				errorMessage,
			);
		}
		return this.publicKey;
	}

	private resolveSigner(
		operationSigner?: TransactionSigner | Keypair,
	): TransactionSigner | Keypair {
		const signer = operationSigner ?? this.signer;
		if (!signer) {
			throw new ConfigurationError(
				ErrorCodes.INVALID_CONFIGURATION,
				"No signer configured. Provide `signer` in constructor, call `setSigner(...)`, or pass `options.signer` for this operation.",
			);
		}
		if (operationSigner) {
			this.signer = operationSigner;
			this.publicKey = operationSigner.publicKey;
		}
		return signer;
	}

	private async resolveSigned(
		operationSigner?: TransactionSigner | Keypair,
		signedOverride?: Signed,
	): Promise<Signed> {
		if (signedOverride) {
			return signedOverride;
		}

		const signer = this.resolveSigner(operationSigner);
		const signerKey = signer.publicKey.toBase58();
		const cachedSigned = this.accountSignCache.get(signerKey);
		if (cachedSigned) {
			return cachedSigned;
		}

		const signed = await this.generateAccountSignForSigner(signer);
		this.accountSignCache.set(signerKey, signed);
		return signed;
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
	private async generateAccountSignForSigner(
		signer: TransactionSigner | Keypair,
	): Promise<Signed> {
		if (isKeypair(signer)) {
			return await getAccountSign(signer);
		} else {
			// For wallet adapters, create a deterministic signature from the public key
			// This avoids requiring user approval for account initialization
			const message = new TextEncoder().encode(
				"Cloak Privacy Account",
			);
			const publicKeyBytes = signer.publicKey.toBytes();

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
				publicKey: signer.publicKey,
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
		operationSigner?: TransactionSigner | Keypair,
	): Promise<VersionedTransaction> {
		const signer = this.resolveSigner(operationSigner);
		if (isKeypair(signer)) {
			transaction.sign([signer]);
			return transaction;
		} else {
			return await signer.signTransaction(transaction);
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
