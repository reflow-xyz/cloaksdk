/**
 * Cloak SDK Error Codes
 *
 * Structured error system with typed error codes for better error handling
 */

// Error code constants
export const ErrorCodes = {
  // Validation Errors (1000-1999)
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_MINT_ADDRESS: 'INVALID_MINT_ADDRESS',
  NO_UNSPENT_UTXOS: 'NO_UNSPENT_UTXOS',
  INVALID_UTXO_COUNT: 'INVALID_UTXO_COUNT',
  UTXO_WALLET_SIGNATURE_REQUIRED: 'UTXO_WALLET_SIGNATURE_REQUIRED',
  UTXO_WALLET_SIGN_TRANSACTION_REQUIRED: 'UTXO_WALLET_SIGN_TRANSACTION_REQUIRED',

  // Network Errors (2000-2999)
  RPC_ERROR: 'RPC_ERROR',
  RELAYER_ERROR: 'RELAYER_ERROR',
  API_FETCH_FAILED: 'API_FETCH_FAILED',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  CONNECTION_FAILED: 'CONNECTION_FAILED',

  // Transaction Errors (3000-3999)
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  TRANSACTION_TIMEOUT: 'TRANSACTION_TIMEOUT',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
  ROOT_MISMATCH: 'ROOT_MISMATCH',
  ROOT_VERIFICATION_FAILED: 'ROOT_VERIFICATION_FAILED',
  NULLIFIER_ALREADY_USED: 'NULLIFIER_ALREADY_USED',
  EXT_DATA_HASH_MISMATCH: 'EXT_DATA_HASH_MISMATCH',
  INVALID_PROOF: 'INVALID_PROOF',
  SIGNATURE_VERIFICATION_FAILED: 'SIGNATURE_VERIFICATION_FAILED',

  // Encryption Errors (4000-4999)
  DECRYPTION_FAILED: 'DECRYPTION_FAILED',
  ENCRYPTION_FAILED: 'ENCRYPTION_FAILED',
  INVALID_ENCRYPTION_KEY: 'INVALID_ENCRYPTION_KEY',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',

  // State Errors (5000-5999)
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'ALREADY_INITIALIZED',
  INVALID_STATE: 'INVALID_STATE',
  CACHE_ERROR: 'CACHE_ERROR',

  // Configuration Errors (6000-6999)
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  HASHER_NOT_INITIALIZED: 'HASHER_NOT_INITIALIZED',
  SIGN_TRANSACTION_REQUIRED: 'SIGN_TRANSACTION_REQUIRED',

  // Token Account Errors (7000-7999)
  TOKEN_ACCOUNT_NOT_FOUND: 'TOKEN_ACCOUNT_NOT_FOUND',
  INVALID_TOKEN_ACCOUNT: 'INVALID_TOKEN_ACCOUNT',
  INSUFFICIENT_TOKEN_BALANCE: 'INSUFFICIENT_TOKEN_BALANCE',
  TOKEN_ACCOUNT_CREATION_FAILED: 'TOKEN_ACCOUNT_CREATION_FAILED',

  // Proof Generation Errors (8000-8999)
  PROOF_GENERATION_FAILED: 'PROOF_GENERATION_FAILED',
  CIRCUIT_NOT_FOUND: 'CIRCUIT_NOT_FOUND',
  WITNESS_GENERATION_FAILED: 'WITNESS_GENERATION_FAILED',
  COMMITMENT_GENERATION_FAILED: 'COMMITMENT_GENERATION_FAILED',

  // Unknown/Generic Errors (9000-9999)
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Base error class for all Cloak SDK errors
 */
export class CloakError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, any>;
  public readonly originalError?: Error;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any>,
    originalError?: Error
  ) {
    super(message);
    this.name = 'CloakError';
    this.code = code;
    this.details = details;
    this.originalError = originalError;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON for logging/serialization
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      stack: this.stack,
      originalError: this.originalError ? {
        name: this.originalError.name,
        message: this.originalError.message,
        stack: this.originalError.stack,
      } : undefined,
    };
  }
}

/**
 * Validation errors - invalid inputs or state
 */
export class ValidationError extends CloakError {
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any>,
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'ValidationError';
  }
}

/**
 * Network errors - RPC, relayer, or API failures
 */
export class NetworkError extends CloakError {
  public readonly statusCode?: number;
  public readonly endpoint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any> & { statusCode?: number; endpoint?: string },
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'NetworkError';
    this.statusCode = details?.statusCode;
    this.endpoint = details?.endpoint;
  }
}

/**
 * Transaction errors - on-chain transaction failures
 */
export class TransactionError extends CloakError {
  public readonly signature?: string;
  public readonly transactionLogs?: string[];

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any> & { signature?: string; transactionLogs?: string[] },
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'TransactionError';
    this.signature = details?.signature;
    this.transactionLogs = details?.transactionLogs;
  }
}

/**
 * Encryption errors - encryption/decryption failures
 */
export class EncryptionError extends CloakError {
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any>,
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'EncryptionError';
  }
}

/**
 * Configuration errors - missing or invalid configuration
 */
export class ConfigurationError extends CloakError {
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any>,
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'ConfigurationError';
  }
}

/**
 * Proof generation errors - ZK proof related failures
 */
export class ProofError extends CloakError {
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, any>,
    originalError?: Error
  ) {
    super(code, message, details, originalError);
    this.name = 'ProofError';
  }
}

/**
 * Helper function to check if an error is a CloakError
 */
export function isCloakError(error: any): error is CloakError {
  return error instanceof CloakError;
}

/**
 * Helper function to check if an error has a specific code
 */
export function hasErrorCode(error: any, code: ErrorCode): boolean {
  return isCloakError(error) && error.code === code;
}

/**
 * Helper to wrap unknown errors in CloakError
 */
export function wrapError(error: unknown, defaultCode: ErrorCode = ErrorCodes.UNKNOWN_ERROR): CloakError {
  if (isCloakError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new CloakError(defaultCode, error.message, undefined, error);
  }

  return new CloakError(
    defaultCode,
    typeof error === 'string' ? error : 'An unknown error occurred',
    { originalValue: error }
  );
}
