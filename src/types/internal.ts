/**
 * Internal types used throughout the SDK
 * These types provide strong typing for internal data structures
 */

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import type { Utxo } from '../models/utxo';

/**
 * Light Protocol WASM hasher instance
 * Used for Poseidon hashing in zero-knowledge proofs
 * Matches @lightprotocol/hasher.rs interface exactly
 */
export interface LightWasm {
  poseidonHash(input: string[] | BN[]): Uint8Array;
  poseidonHashString(input: string[] | BN[]): string;
  poseidonHashBN(input: string[] | BN[]): BN;
  blakeHash(input: string | Uint8Array, hashLength: number): Uint8Array;
}

/**
 * Status callback function for operation progress updates
 */
export type StatusCallback = (status: string) => void;

/**
 * Merkle tree proof structure
 */
export interface MerkleProof {
  /** Merkle tree path elements (sibling hashes) */
  pathElements: string[];
  /** Path indices (0 for left, 1 for right) */
  pathIndices: number[];
  /** Leaf index in the Merkle tree */
  index: number;
  /** Merkle tree root */
  root: string;
  /** Next available index in the tree */
  nextIndex: number;
}

/**
 * Zero-knowledge proof structure
 */
export interface ZKProof {
  /** Proof component A */
  proofA: Uint8Array;
  /** Proof component B (flattened) */
  proofB: Uint8Array[];
  /** Proof component C */
  proofC: Uint8Array;
  /** Merkle tree root */
  root: Uint8Array;
  /** Public amount (encoded) */
  publicAmount: Uint8Array;
  /** External data hash */
  extDataHash: Uint8Array;
  /** Input nullifiers (spent UTXOs) */
  inputNullifiers: Uint8Array[];
  /** Output commitments (new UTXOs) */
  outputCommitments: Uint8Array[];
}

/**
 * External data for transactions (encrypted UTXO outputs)
 */
export interface ExtData {
  /** Recipient address for withdrawals */
  recipient: PublicKey;
  /** External amount (positive for deposit, negative for withdrawal) */
  extAmount: BN;
  /** Encrypted output UTXO 1 */
  encryptedOutput1: Uint8Array;
  /** Encrypted output UTXO 2 */
  encryptedOutput2: Uint8Array;
  /** Transaction fee amount */
  fee: BN;
  /** Fee recipient address */
  feeRecipient: PublicKey;
  /** Mint address (native SOL or SPL token) */
  mintAddress: string;
}

/**
 * Transaction input for proof generation
 */
export interface ProofInput {
  // Common transaction data
  root: string;
  inputNullifier: string[];
  outputCommitment: string[];
  publicAmount: string;
  extDataHash: string;

  // Input UTXO data (UTXOs being spent)
  inAmount: string[];
  inPrivateKey: string[];
  inBlinding: string[];
  inPathIndices: number[];
  inPathElements: string[][];

  // Output UTXO data (UTXOs being created)
  outAmount: string[];
  outBlinding: string[];
  outPubkey: string[];

  // Mint address
  mintAddress: string;
}

/**
 * Relayer API response for merkle proof
 */
export interface MerkleProofResponse {
  index: number;
  pathElements: string[];
  pathIndices: number[];
  root: string;
  nextIndex: number;
}

/**
 * Relayer API response for tree state
 */
export interface TreeStateResponse {
  root: string;
  nextIndex: number;
}

/**
 * API UTXO structure from relayer
 */
export interface ApiUtxo {
  commitment: string;
  encrypted_output: string;
  index: number;
  nullifier?: string;
}

/**
 * API response format for UTXO queries
 */
export interface ApiUtxoResponse {
  count: number;
  encrypted_outputs: string[];
}

/**
 * Decryption result for UTXO batch processing
 */
export interface DecryptionResult {
  status: 'decrypted' | 'failed' | 'wrong_key' | 'skipped' | 'unDecrypted';
  utxo?: Utxo;
  error?: string;
}

/**
 * Fetched UTXO batch with metadata
 */
export interface FetchedUtxoBatch {
  utxos: Utxo[];
  encryptedOutputs: string[];
  hashMore: boolean;
}

/**
 * UTXO cache structure for optimization
 */
export interface UtxoCache {
  /** All encrypted outputs fetched so far */
  encryptedOutputs: string[];
  /** Last index we fetched up to */
  lastFetchedIndex: number;
}

/**
 * Transaction size validation result
 */
export interface TransactionSizeValidation {
  isValid: boolean;
  size: number;
  maxSize: number;
  error?: string;
}

/**
 * Withdrawal amount validation result
 */
export interface WithdrawalValidation {
  isPartial: boolean;
  adjustedAmount: number;
}

/**
 * Error parsing result
 */
export interface ParsedError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Nullifier PDA addresses
 */
export interface NullifierPDAs {
  nullifier0PDA: PublicKey;
  nullifier1PDA: PublicKey;
}

/**
 * Batch withdrawal parameters
 */
export interface BatchWithdrawalParams {
  amount: number;
  utxos: Utxo[];
}

/**
 * Delayed withdrawal result
 */
export interface DelayedWithdrawalResult {
  delayedWithdrawalId: number;
  executeAt: string;
}

/**
 * Transaction submission parameters for relayer
 */
export interface WithdrawParams {
  proof: ZKProof;
  extData: ExtData;
  recipient: PublicKey;
  delayMinutes?: number;
}
