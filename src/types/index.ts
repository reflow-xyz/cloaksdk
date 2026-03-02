import { PublicKey, Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';

/**
 * Transaction signer interface for wallet adapter compatibility
 * Supports both Keypair (direct) and wallet adapter (BackpackSolanaWallet) patterns
 */
export interface TransactionSigner {
  /** Public key of the signer */
  publicKey: PublicKey;
  /** Sign a single transaction */
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  /** Sign multiple transactions */
  signAllTransactions?<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  /** Sign a message (for account signature generation) */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Signed account information used internally
 */
export interface Signed {
  publicKey: PublicKey;
  signature: Uint8Array;
}

/**
 * Configuration options for initializing the Cloak SDK
 */
export interface CloakSDKConfig {
  /** Solana connection instance */
  connection: Connection;
  /** relayer API URL for relaying transactions */
  relayerUrl: string;
  /** Program ID of the Cloak privacy protocol */
  programId?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Path to circuit files (without extension) for ZK proof generation */
  circuitPath?: string;
  /**
   * Address Lookup Table (ALT) address for transaction optimization.
   * Required for all transactions. Use the appropriate ALT for your cluster:
   * - Mainnet: G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj
   * - Devnet: Dy1kWrcceThLo9ywoMH2MpWTsBe9pxsv3fCcTj3sSDK9
   */
  altAddress: PublicKey | string;
}

/**
 * Options for deposit operations
 */
export interface DepositOptions {
  /** Amount to deposit (in SOL for native, in base units for SPL) */
  amount: number;
  /** Optional signer override for this operation */
  signer?: TransactionSigner | Keypair;
  /**
   * Whether to consolidate existing UTXOs into the new deposit.
   * Default: false (fresh-input mode) to avoid stale/nullifier-collision retries.
   */
  consolidate?: boolean;
  /** Optional callback for status updates */
  onStatus?: (status: string) => void;
  /** Maximum number of retry attempts on failure (default: 3) */
  maxRetries?: number;
  /** Optional: different wallet's signature for UTXO keypair derivation (for multi-wallet scenarios) */
  utxoWalletSigned?: Signed;
  /** Optional: callback to sign transactions with the UTXO wallet (required when utxoWalletSigned is provided for deposits) */
  utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Options for SPL token deposit operations
 */
export interface DepositSplOptions extends DepositOptions {
  /** SPL token mint address */
  mintAddress: string;
  /** Optional: different wallet's signature for UTXO keypair derivation (for multi-wallet scenarios) */
  utxoWalletSigned?: Signed;
  /** Optional: callback to sign transactions with the UTXO wallet (required when utxoWalletSigned is provided for deposits) */
  utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Options for batch deposit operations
 */
export interface BatchDepositOptions {
  /** Total amount to deposit (will be broken down into denominations) */
  amount: number;
  /** Optional signer override for this operation */
  signer?: TransactionSigner | Keypair;
  /** Optional callback for status updates */
  onStatus?: (status: string) => void;
  /** Maximum number of retry attempts on failure (default: 3) */
  maxRetries?: number;
  /** Optional: different wallet's signature for UTXO keypair derivation (for multi-wallet scenarios) */
  utxoWalletSigned?: Signed;
  /** Optional: callback to sign transactions with the UTXO wallet */
  utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Options for batch SPL token deposit operations
 */
export interface BatchDepositSplOptions extends BatchDepositOptions {
  /** SPL token mint address */
  mintAddress: string;
}

/**
 * Options for withdraw operations
 */
export interface WithdrawOptions {
  /** Recipient address */
  recipientAddress: PublicKey | string;
  /** Amount to withdraw (in SOL for native, in base units for SPL) */
  amount: number;
  /** Optional signer override for this operation */
  signer?: TransactionSigner | Keypair;
  /** Optional delay in minutes before withdrawal is executed (0 for immediate) */
  delayMinutes?: number;
  /** Optional callback for status updates */
  onStatus?: (status: string) => void;
  /** Maximum number of retry attempts on failure (default: 3) */
  maxRetries?: number;
  /** Optional: different wallet's signature for UTXO keypair derivation (for multi-wallet scenarios) */
  utxoWalletSigned?: Signed;
  /** Optional: callback to sign transactions with the UTXO wallet (for API consistency, not currently used in withdrawals) */
  utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  /** Optional: provide specific UTXOs to use (for batch withdrawals) */
  providedUtxos?: import('../models/utxo').Utxo[];
}

/**
 * Options for SPL token withdraw operations
 */
export interface WithdrawSplOptions extends WithdrawOptions {
  /** SPL token mint address */
  mintAddress: string;
  /** Optional: different wallet's signature for UTXO keypair derivation (for multi-wallet scenarios) */
  utxoWalletSigned?: Signed;
  /** Optional: callback to sign transactions with the UTXO wallet (for API consistency, not currently used in withdrawals) */
  utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Result of a deposit operation
 */
export interface DepositResult {
  /** Whether the deposit was successful */
  success: boolean;
  /** Transaction signature (if successful) */
  signature?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Result of a batch deposit operation
 */
export interface BatchDepositResult {
  /** Whether all deposits were successful */
  success: boolean;
  /** Array of transaction signatures */
  signatures: string[];
  /** Number of successful deposits */
  successCount: number;
  /** Total number of deposits attempted */
  totalCount: number;
  /** Error message (if any failed) */
  error?: string;
}

/**
 * Result of a withdraw operation
 */
export interface WithdrawResult {
  /** Whether withdrawal was partial (insufficient balance) */
  isPartial: boolean;
  /** Whether the withdrawal was successful */
  success?: boolean;
  /** Transaction signature (if immediate withdrawal, or first signature if batch) */
  signature?: string;
  /** All transaction signatures (for batch withdrawals with >2 UTXOs) */
  signatures?: string[];
  /** Delayed withdrawal ID (if delayed) */
  delayedWithdrawalId?: string;
  /** Execution timestamp (if delayed) */
  executeAt?: string;
  /** Error message (if failed) */
  error?: string;
  /** Max withdrawable amount in SOL (withdrawSol) when request is too large */
  maxWithdrawableAmount?: number;
  /** Max withdrawable amount in lamports (as string) when request is too large */
  maxWithdrawableLamports?: string;
}

/**
 * Timed withdrawal type discriminator
 */
export type TimedWithdrawalType = "sol" | "spl";

/**
 * Pending timed withdrawal record returned by relayer
 */
export interface TimedWithdrawal {
  /** Numeric database ID used for cancellation */
  id: number;
  /** Stable UUID identifier for tracking */
  delayedWithdrawalId: string | null;
  /** User public key that scheduled this timed withdrawal */
  userPubkey: string | null;
  /** Whether this timed withdrawal is SOL or SPL */
  type: TimedWithdrawalType | string;
  /** Recipient public key */
  recipient: string;
  /** Delay configured at scheduling time (minutes) */
  delayMinutes: number;
  /** Scheduled execution timestamp (ISO string) */
  executeAt: string;
  /** Current status */
  status: string;
  /** Optional transaction signature if already executed */
  transactionHash?: string | null;
  /** Optional failure reason */
  errorMessage?: string | null;
  /** SPL mint address when `type` is `spl` */
  mintAddress?: string | null;
}

/**
 * Options for querying timed withdrawals
 */
export interface TimedWithdrawalQueryOptions {
  /** Optional signer override */
  signer?: TransactionSigner | Keypair;
  /** Filter by withdrawal type. Default: "all" */
  type?: TimedWithdrawalType | "all";
}

/**
 * Options for canceling a single timed withdrawal
 */
export interface CancelTimedWithdrawalOptions {
  /** Optional signer override */
  signer?: TransactionSigner | Keypair;
  /** Optional explicit timed withdrawal type */
  type?: TimedWithdrawalType;
}

/**
 * Result for canceling a single timed withdrawal
 */
export interface CancelTimedWithdrawalResult {
  /** Timed withdrawal numeric ID */
  id: number;
  /** Timed withdrawal type if resolved */
  type?: TimedWithdrawalType;
  /** Whether cancellation succeeded */
  success: boolean;
  /** Backend success message (if provided) */
  message?: string;
  /** Error message for failed cancellation */
  error?: string;
}

/**
 * Result for canceling many timed withdrawals
 */
export interface CancelManyTimedWithdrawalsResult {
  /** Whether all requested cancellations succeeded */
  success: boolean;
  /** Number of requested IDs after deduplication/validation */
  requested: number;
  /** Number of successfully canceled timed withdrawals */
  canceled: number;
  /** Per-ID cancellation results */
  results: CancelTimedWithdrawalResult[];
  /** Error message for request-level failures */
  error?: string;
}

/**
 * Options for canceling many timed withdrawals
 */
export interface CancelManyTimedWithdrawalsOptions
  extends CancelTimedWithdrawalOptions {}

/**
 * Options for canceling all timed withdrawals
 */
export interface CancelAllTimedWithdrawalsOptions
  extends TimedWithdrawalQueryOptions {}

/**
 * Result for canceling all timed withdrawals
 */
export interface CancelAllTimedWithdrawalsResult
  extends CancelManyTimedWithdrawalsResult {
  /** Number of pending timed withdrawals discovered for the wallet/type */
  totalPending: number;
}

/**
 * UTXO balance information
 */
export interface UtxoBalance {
  /** Total balance in lamports/base units */
  total: BN;
  /** Number of UTXOs */
  count: number;
  /** Mint address (for SPL tokens) */
  mintAddress?: string;
}

/**
 * Balance result for a specific keypair
 */
export interface BatchBalanceEntry {
  /** Wallet public key in base58 */
  publicKey: string;
  /** UTXO balance details */
  balance: UtxoBalance;
}

/**
 * Options for estimating max transferable SOL from private balance.
 */
export interface MaxTransferableOptions {
  /**
   * Number of withdrawal transactions you plan to execute.
   * Each withdrawal can incur fixed overhead (e.g. nullifier account rent).
   * Default: 1
   */
  numberOfWithdrawals?: number;
  /**
   * Withdrawal fee rate in percent.
   * Default: protocol withdraw fee rate (currently 0.3).
   */
  withdrawFeeRatePercent?: number;
  /**
   * Fixed per-withdrawal cost (in SOL) debited from private balance.
   * Default is based on two nullifier accounts: 2 * 0.00095352 SOL.
   */
  fixedCostPerWithdrawalSol?: number;
  /**
   * Force fresh UTXO fetch for source balance.
   * Default: true.
   */
  forceRefresh?: boolean;
  /** Optional signer override for this operation */
  signer?: TransactionSigner | Keypair;
  /** Optional signed UTXO wallet identity override */
  utxoWalletSigned?: Signed;
}

/**
 * Result for max transferable SOL estimation.
 */
export interface MaxTransferableResult {
  /** Max transferable recipient amount (SOL), after variable and fixed fees */
  maxTransferableAmount: number;
  /** Max transferable recipient amount in lamports (exact) */
  maxTransferableLamports: string;
  /** Available private balance (SOL) at time of estimation */
  availableAmount: number;
  /** Available private balance in lamports (exact) */
  availableLamports: string;
  /** Number of withdrawals used in the estimate */
  numberOfWithdrawals: number;
  /** Variable withdrawal fee rate percent used in estimate */
  withdrawFeeRatePercent: number;
  /** Fixed per-withdrawal cost used in estimate (SOL) */
  fixedCostPerWithdrawalSol: number;
  /** Total fixed costs across all withdrawals (SOL) */
  totalFixedCostSol: number;
  /** Total fixed costs across all withdrawals in lamports (exact) */
  totalFixedCostLamports: string;
  /** Variable fee at max transferable amount (SOL) */
  estimatedVariableFeeSol: number;
  /** Variable fee at max transferable amount in lamports (exact) */
  estimatedVariableFeeLamports: string;
  /** Total estimated fees at max transferable amount (SOL) */
  estimatedTotalFeeSol: number;
  /** Total estimated fees at max transferable amount in lamports (exact) */
  estimatedTotalFeeLamports: string;
}

/**
 * Per-transfer leg result
 */
export interface TransferLegResult {
  /** Source wallet public key in base58 */
  from: string;
  /** Destination wallet public key in base58 */
  to: string;
  /** Requested amount in SOL */
  requestedAmount: number;
  /** Withdraw result from the transfer leg */
  result: WithdrawResult;
}

/**
 * Options for transfer between sets of keypairs
 */
export interface TransferOptions {
  /** Source keypairs that hold private pool balance */
  in: Keypair[];
  /** Destination keypairs */
  out: Keypair[];
  /** Total amount to transfer in SOL */
  amount: number;
  /**
   * Basis point split by destination wallet.
   * Keys can be Keypair/PublicKey/string and values are basis points.
   */
  bps?: Map<Keypair | PublicKey | string, number>;
  /** Optional delay in minutes for each withdrawal leg */
  delay?: number;
  /** Optional callback for status updates */
  onStatus?: (status: string) => void;
  /** Maximum number of retry attempts per withdrawal leg */
  maxRetries?: number;
}

/**
 * Result of transfer operation
 */
export interface TransferResult {
  /** Whether all transfer legs succeeded */
  success: boolean;
  /** Total requested transfer amount in SOL */
  requestedAmount: number;
  /** Actual amount attempted across all legs in SOL */
  attemptedAmount: number;
  /** Individual withdrawal leg results */
  legs: TransferLegResult[];
  /** Error message if transfer planning fails */
  error?: string;
}

/**
 * Per-account transferBack result
 */
export interface TransferBackEntry {
  /** Source wallet public key in base58 */
  from: string;
  /** Number of delayed withdrawals canceled */
  canceledPending: number;
  /** Cancellation warnings, if any */
  cancelWarnings?: string[];
  /** SOL balance (lamports) before transferBack */
  balanceLamports: string;
  /** Max transferable amount after fees (SOL) */
  maxTransferableAmount?: number;
  /** Max transferable amount after fees (lamports) */
  maxTransferableLamports?: string;
  /** Withdraw result for transferring funds back */
  withdrawResult?: WithdrawResult;
}

/**
 * Options for transferBack operation
 */
export interface TransferBackOptions {
  /**
   * Automatically deposit successfully transferred-back SOL into the Cloak pool
   * of the SDK signer after withdrawals complete.
   * Default: false
   */
  redepositToPool?: boolean;
  /** Optional callback for status updates */
  onStatus?: (status: string) => void;
}

/**
 * Result of transferBack operation
 */
export interface TransferBackResult {
  /** Whether all transferBack attempts succeeded */
  success: boolean;
  /** Per-wallet transferBack details */
  entries: TransferBackEntry[];
  /** Total SOL successfully transferred back to signer wallet (before optional redeposit) */
  transferredBackAmount?: number;
  /** Result of optional redeposit into Cloak pool */
  redepositResult?: DepositResult;
  /** Error message if operation fails early */
  error?: string;
}

// Export internal types for advanced usage
export type {
  LightWasm,
  StatusCallback,
  MerkleProof,
  ZKProof,
  ExtData,
  ProofInput,
  MerkleProofResponse,
  TreeStateResponse,
  ApiUtxo,
  ApiUtxoResponse,
  DecryptionResult,
  FetchedUtxoBatch,
  UtxoCache,
  TransactionSizeValidation,
  WithdrawalValidation,
  ParsedError,
  NullifierPDAs,
  BatchWithdrawalParams,
  DelayedWithdrawalResult,
  WithdrawParams,
} from './internal';
