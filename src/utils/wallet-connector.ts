/**
 * Wallet Connector - Bridge Solana wallet adapters to Cloak SDK
 *
 * This utility provides a simple way to connect Solana wallet adapters
 * (Phantom, Backpack, Solflare, etc.) to the Cloak SDK.
 */

import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { WalletAdapter, WalletReadyState } from '@solana/wallet-adapter-base';
import type { TransactionSigner, Signed } from '../types';
import { ValidationError, ErrorCodes } from '../errors';

/**
 * Extended wallet adapter interface with signing capabilities
 * Most wallet adapters implement these methods
 */
export interface SignableWalletAdapter extends WalletAdapter {
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Wallet connection state
 */
export interface WalletConnectionState {
  connected: boolean;
  connecting: boolean;
  publicKey: PublicKey | null;
  walletName: string;
  readyState: WalletReadyState;
}

/**
 * Options for the WalletConnector
 */
export interface WalletConnectorOptions {
  /** Auto-reconnect on page reload if previously connected */
  autoConnect?: boolean;
  /** Callback when wallet connects */
  onConnect?: (publicKey: PublicKey) => void;
  /** Callback when wallet disconnects */
  onDisconnect?: () => void;
  /** Callback on wallet error */
  onError?: (error: Error) => void;
}

/**
 * WalletConnector - Bridges Solana wallet adapters to Cloak SDK
 *
 * @example
 * ```typescript
 * import { WalletConnector } from '@cloak-dev/sdk';
 * import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
 *
 * // Create wallet adapter
 * const phantomAdapter = new PhantomWalletAdapter();
 *
 * // Create connector
 * const connector = new WalletConnector(phantomAdapter, {
 *   onConnect: (pubkey) => console.log('Connected:', pubkey.toBase58()),
 *   onDisconnect: () => console.log('Disconnected'),
 * });
 *
 * // Connect wallet
 * await connector.connect();
 *
 * // Get signer for Cloak SDK
 * const signer = connector.getSigner();
 *
 * // Use with Cloak SDK
 * const sdk = new CloakSDK({
 *   connection,
 *   relayerUrl: 'https://...',
 * });
 * sdk.setSigner(signer);
 * ```
 */
export class WalletConnector {
  private adapter: SignableWalletAdapter;
  private options: WalletConnectorOptions;
  private eventListenerCleanup: (() => void) | null = null;

  constructor(adapter: SignableWalletAdapter, options: WalletConnectorOptions = {}) {
    this.adapter = adapter;
    this.options = options;
    this.setupEventListeners();
  }

  /**
   * Set up event listeners for wallet events
   */
  private setupEventListeners(): void {
    const handleConnect = (publicKey: PublicKey) => {
      this.options.onConnect?.(publicKey);
    };

    const handleDisconnect = () => {
      this.options.onDisconnect?.();
    };

    const handleError = (error: Error) => {
      this.options.onError?.(error);
    };

    this.adapter.on('connect', handleConnect);
    this.adapter.on('disconnect', handleDisconnect);
    this.adapter.on('error', handleError);

    this.eventListenerCleanup = () => {
      this.adapter.off('connect', handleConnect);
      this.adapter.off('disconnect', handleDisconnect);
      this.adapter.off('error', handleError);
    };
  }

  /**
   * Connect to the wallet
   * @throws {ValidationError} If wallet is not installed or connection fails
   */
  async connect(): Promise<PublicKey> {
    if (this.adapter.connected && this.adapter.publicKey) {
      return this.adapter.publicKey;
    }

    try {
      await this.adapter.connect();

      if (!this.adapter.publicKey) {
        throw new ValidationError(
          ErrorCodes.WALLET_NOT_CONNECTED,
          'Wallet connected but public key is null'
        );
      }

      return this.adapter.publicKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown connection error';
      throw new ValidationError(
        ErrorCodes.WALLET_CONNECTION_FAILED,
        `Failed to connect wallet: ${message}`
      );
    }
  }

  /**
   * Disconnect from the wallet
   */
  async disconnect(): Promise<void> {
    try {
      await this.adapter.disconnect();
    } catch (error) {
      // Silently handle disconnect errors
    }
  }

  /**
   * Get the current connection state
   */
  getState(): WalletConnectionState {
    return {
      connected: this.adapter.connected,
      connecting: this.adapter.connecting,
      publicKey: this.adapter.publicKey,
      walletName: this.adapter.name,
      readyState: this.adapter.readyState,
    };
  }

  /**
   * Check if the wallet is connected
   */
  get isConnected(): boolean {
    return this.adapter.connected && this.adapter.publicKey !== null;
  }

  /**
   * Get the connected wallet's public key
   * @throws {ValidationError} If wallet is not connected
   */
  get publicKey(): PublicKey {
    if (!this.adapter.publicKey) {
      throw new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet not connected'
      );
    }
    return this.adapter.publicKey;
  }

  /**
   * Get a TransactionSigner compatible with Cloak SDK
   * @throws {ValidationError} If wallet is not connected or doesn't support signing
   */
  getSigner(): TransactionSigner {
    if (!this.adapter.connected || !this.adapter.publicKey) {
      throw new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet must be connected before getting signer'
      );
    }

    if (typeof this.adapter.signTransaction !== 'function') {
      throw new ValidationError(
        ErrorCodes.WALLET_SIGNING_NOT_SUPPORTED,
        'Wallet adapter does not support transaction signing'
      );
    }

    const signer: TransactionSigner = {
      publicKey: this.adapter.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        if (!this.adapter.connected) {
          throw new ValidationError(
            ErrorCodes.WALLET_DISCONNECTED,
            'Wallet disconnected during signing'
          );
        }
        return this.adapter.signTransaction(tx);
      },
    };

    // Add optional signAllTransactions if supported
    if (typeof this.adapter.signAllTransactions === 'function') {
      signer.signAllTransactions = async <T extends Transaction | VersionedTransaction>(
        txs: T[]
      ): Promise<T[]> => {
        if (!this.adapter.connected) {
          throw new ValidationError(
            ErrorCodes.WALLET_DISCONNECTED,
            'Wallet disconnected during signing'
          );
        }
        return this.adapter.signAllTransactions!(txs);
      };
    }

    // Add optional signMessage if supported
    if (typeof this.adapter.signMessage === 'function') {
      signer.signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
        if (!this.adapter.connected) {
          throw new ValidationError(
            ErrorCodes.WALLET_DISCONNECTED,
            'Wallet disconnected during signing'
          );
        }
        return this.adapter.signMessage!(message);
      };
    }

    return signer;
  }

  /**
   * Sign a message with the connected wallet
   * @throws {ValidationError} If wallet doesn't support message signing
   */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.adapter.connected) {
      throw new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet not connected'
      );
    }

    if (typeof this.adapter.signMessage !== 'function') {
      throw new ValidationError(
        ErrorCodes.WALLET_SIGNING_NOT_SUPPORTED,
        'Wallet does not support message signing'
      );
    }

    return this.adapter.signMessage(message);
  }

  /**
   * Generate a Signed object for UTXO derivation
   * This is useful for multi-wallet scenarios where you want to use
   * a different wallet's signature for UTXO keypair derivation
   *
   * @param message Optional custom message to sign (defaults to "Cloak Privacy Account")
   * @returns Signed object with publicKey and signature
   */
  async generateSignature(message?: string): Promise<Signed> {
    if (!this.adapter.connected || !this.adapter.publicKey) {
      throw new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet not connected'
      );
    }

    const messageBytes = new TextEncoder().encode(message || 'Cloak Privacy Account');
    const signature = await this.signMessage(messageBytes);

    return {
      publicKey: this.adapter.publicKey,
      signature,
    };
  }

  /**
   * Clean up event listeners and resources
   */
  destroy(): void {
    this.eventListenerCleanup?.();
    this.eventListenerCleanup = null;
  }
}

/**
 * Create a TransactionSigner from a wallet adapter
 * Simple helper function for quick integration
 *
 * @example
 * ```typescript
 * import { createSignerFromAdapter } from '@cloak-dev/sdk';
 * import { useWallet } from '@solana/wallet-adapter-react';
 *
 * function MyComponent() {
 *   const wallet = useWallet();
 *
 *   const handleDeposit = async () => {
 *     const signer = createSignerFromAdapter(wallet);
 *     const sdk = new CloakSDK({ connection, relayerUrl });
 *     sdk.setSigner(signer);
 *     await sdk.initialize();
 *     await sdk.depositSol({ amount: 0.1 });
 *   };
 * }
 * ```
 */
export function createSignerFromAdapter(
  adapter: SignableWalletAdapter | {
    publicKey: PublicKey | null;
    signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
    signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    connected?: boolean;
  }
): TransactionSigner {
  const publicKey = adapter.publicKey;

  if (!publicKey) {
    throw new ValidationError(
      ErrorCodes.WALLET_NOT_CONNECTED,
      'Wallet must be connected (publicKey is null)'
    );
  }

  // Check if connected property exists and is false
  if ('connected' in adapter && adapter.connected === false) {
    throw new ValidationError(
      ErrorCodes.WALLET_NOT_CONNECTED,
      'Wallet is not connected'
    );
  }

  if (typeof adapter.signTransaction !== 'function') {
    throw new ValidationError(
      ErrorCodes.WALLET_SIGNING_NOT_SUPPORTED,
      'Wallet adapter must implement signTransaction'
    );
  }

  const signer: TransactionSigner = {
    publicKey,
    signTransaction: (tx) => adapter.signTransaction!(tx),
  };

  if (typeof adapter.signAllTransactions === 'function') {
    signer.signAllTransactions = (txs) => adapter.signAllTransactions!(txs);
  }

  if (typeof adapter.signMessage === 'function') {
    signer.signMessage = (message) => adapter.signMessage!(message);
  }

  return signer;
}

/**
 * Check if a wallet adapter supports all required signing methods
 */
export function isSignableAdapter(adapter: WalletAdapter): adapter is SignableWalletAdapter {
  const candidate = adapter as { signTransaction?: unknown };
  return typeof candidate.signTransaction === 'function';
}

/**
 * Check if a wallet adapter supports batch signing
 */
export function supportsBatchSigning(adapter: WalletAdapter | SignableWalletAdapter): boolean {
  const candidate = adapter as { signAllTransactions?: unknown };
  return typeof candidate.signAllTransactions === 'function';
}

/**
 * Check if a wallet adapter supports message signing
 */
export function supportsMessageSigning(adapter: WalletAdapter | SignableWalletAdapter): boolean {
  const candidate = adapter as { signMessage?: unknown };
  return typeof candidate.signMessage === 'function';
}
