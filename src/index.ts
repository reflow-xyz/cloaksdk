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
 *   signer: keypair,
 * });
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
  WithdrawOptions,
  WithdrawSplOptions,
  DepositResult,
  WithdrawResult,
  Signed,
  UtxoBalance,
} from './types';

// Export utility functions for advanced usage
export { getHasher } from './utils/hasher';
export { getAccountSign, generateUtxoWalletSignature } from './utils/getAccountSign';
export { planBatchWithdrawals, previewBatchWithdrawal } from './utils/batch-withdraw';
export type { BatchWithdrawPlan } from './utils/batch-withdraw';
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

// Re-export Solana types for convenience
export { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
export type { VersionedTransaction } from '@solana/web3.js';
