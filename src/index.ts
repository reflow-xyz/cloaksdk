/**
 * @cloak-labs/sdk - Cloak Privacy Protocol SDK
 *
 * Official SDK for interacting with the Cloak Privacy Protocol on Solana.
 * Provides simple interfaces for depositing and withdrawing SOL and SPL tokens
 * with zero-knowledge proof privacy guarantees.
 *
 * @example
 * ```typescript
 * import { CloakSDK } from '@cloak-labs/sdk';
 * import { Connection, Keypair } from '@solana/web3.js';
 *
 * // Initialize SDK
 * const connection = new Connection('https://api.devnet.solana.com');
 * const keypair = Keypair.fromSecretKey(secretKeyBytes);
 *
 * const sdk = new CloakSDK({
 *   connection,
 * });
 * sdk.setSigner(keypair);
 *
 * await sdk.initialize();
 *
 * // Deposit SOL
 * await sdk.depositSol({ amount: 0.1 });
 *
 * // Withdraw SOL (delayed)
 * await sdk.withdrawSol({
 *   recipientAddress: 'recipient-pubkey',
 *   amount: 0.05,
 *   delayMinutes: 30
 * });
 * ```
 *
 * @packageDocumentation
 */

// Export main SDK class
export { CloakSDK } from './lib/CloakSDK';

// Export types
export type {
  TransactionSigner,
  CloakSDKConfig,
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
  TransferBackResult,
  BatchBalanceEntry,
} from './types';

// Export utility functions for advanced usage
export { getHasher } from './utils/hasher';
export { getAccountSign, generateUtxoWalletSignature } from './utils/getAccountSign';
export { planBatchWithdrawals, previewBatchWithdrawal } from './utils/batch-withdraw';
export { planBatchDeposits, previewBatchDeposit, planBatchSplDeposits, previewBatchSplDeposit } from './utils/batch-deposit';
export type { BatchWithdrawPlan } from './utils/batch-withdraw';
export type { BatchDepositPlan } from './utils/batch-deposit';
export { isHardwareAccelerationEnabled } from './utils/encryption';

// Export error types and codes
export {
  ErrorCodes,
  CloakError,
  ValidationError,
  NetworkError,
  TransactionError,
  EncryptionError,
  ConfigurationError,
  ProofError,
  isCloakError,
  hasErrorCode,
  wrapError,
} from './errors';
export type { ErrorCode } from './errors';

// Export wallet connector utilities
export {
  WalletConnector,
  createSignerFromAdapter,
  isSignableAdapter,
  supportsBatchSigning,
  supportsMessageSigning,
} from './utils/wallet-connector';
export type {
  SignableWalletAdapter,
  WalletConnectionState,
  WalletConnectorOptions,
} from './utils/wallet-connector';

// Re-export Solana types for convenience
export { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
export type { VersionedTransaction } from '@solana/web3.js';

// Re-export wallet adapter types for convenience
export { WalletReadyState } from '@solana/wallet-adapter-base';
export type { WalletAdapter } from '@solana/wallet-adapter-base';
