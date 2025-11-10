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
  /**
   * Transaction signer - can be either:
   * - A Solana Keypair (for direct signing)
   * - A wallet adapter (BackpackSolanaWallet, Phantom, etc.)
   */
  signer: TransactionSigner | Keypair;
  /** relayer API URL for relaying transactions */
  relayerUrl?: string;
  /** Program ID of the Cloak privacy protocol */
  programId?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Path to circuit files (without extension) for ZK proof generation */
  circuitPath?: string;
}

/**
 * Options for deposit operations
 */
export interface DepositOptions {
  /** Amount to deposit (in SOL for native, in base units for SPL) */
  amount: number;
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
  delayedWithdrawalId?: number;
  /** Execution timestamp (if delayed) */
  executeAt?: string;
  /** Error message (if failed) */
  error?: string;
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
