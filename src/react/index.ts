/**
 * React hooks for Cloak SDK integration with @solana/wallet-adapter-react
 *
 * @example
 * ```typescript
 * import { useCloakSDK } from '@cloak-dev/sdk/react';
 *
 * function MyComponent() {
 *   const { sdk, isReady, error } = useCloakSDK({
 *     relayerUrl: 'https://...',
 *   });
 *
 *   const handleDeposit = async () => {
 *     if (!isReady || !sdk) return;
 *     await sdk.depositSol({ amount: 0.1 });
 *   };
 * }
 * ```
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { CloakSDK } from '../lib/CloakSDK';
import type { CloakSDKConfig, TransactionSigner, Signed } from '../types';
import { ValidationError, ErrorCodes } from '../errors';

/**
 * Options for useCloakSDK hook
 */
export interface UseCloakSDKOptions {
  /** Relayer API URL */
  relayerUrl: string;
  /**
   * Address Lookup Table (ALT) address for transaction optimization.
   * Required for all transactions. Use the appropriate ALT for your cluster:
   * - Mainnet: G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj
   * - Devnet: Dy1kWrcceThLo9ywoMH2MpWTsBe9pxsv3fCcTj3sSDK9
   */
  altAddress: string;
  /** Program ID (optional, uses default if not provided) */
  programId?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Path to circuit files */
  circuitPath?: string;
  /** Auto-initialize SDK when wallet connects */
  autoInitialize?: boolean;
}

/**
 * Return type for useCloakSDK hook
 */
export interface UseCloakSDKReturn {
  /** The CloakSDK instance (null if not ready) */
  sdk: CloakSDK | null;
  /** Whether the SDK is initialized and ready to use */
  isReady: boolean;
  /** Whether the SDK is currently initializing */
  isInitializing: boolean;
  /** Error that occurred during initialization */
  error: Error | null;
  /** Manually initialize the SDK */
  initialize: () => Promise<void>;
  /** Reset the SDK (useful when wallet changes) */
  reset: () => void;
}

/**
 * React hook for using Cloak SDK with @solana/wallet-adapter-react
 *
 * Automatically creates and initializes a CloakSDK instance when a wallet is connected.
 *
 * @example
 * ```typescript
 * import { useCloakSDK } from '@cloak-dev/sdk/react';
 * import { useWallet } from '@solana/wallet-adapter-react';
 *
 * function DepositButton() {
 *   const { sdk, isReady, isInitializing, error } = useCloakSDK({
 *     relayerUrl: 'https://api.cloak.so',
 *   });
 *
 *   if (error) return <div>Error: {error.message}</div>;
 *   if (isInitializing) return <div>Initializing...</div>;
 *   if (!isReady) return <div>Connect wallet to continue</div>;
 *
 *   return (
 *     <button onClick={() => sdk?.depositSol({ amount: 0.1 })}>
 *       Deposit 0.1 SOL
 *     </button>
 *   );
 * }
 * ```
 */
export function useCloakSDK(options: UseCloakSDKOptions): UseCloakSDKReturn {
  const { relayerUrl, altAddress, programId, verbose, circuitPath, autoInitialize = true } = options;

  const { connection } = useConnection();
  const wallet = useWallet();

  const [sdk, setSdk] = useState<CloakSDK | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track the current wallet public key to detect changes
  const currentWalletRef = useRef<string | null>(null);

  // Create signer from wallet
  const signer = useMemo((): TransactionSigner | null => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      return null;
    }

    const signerObj: TransactionSigner = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction.bind(wallet),
    };

    if (wallet.signAllTransactions) {
      signerObj.signAllTransactions = wallet.signAllTransactions.bind(wallet);
    }

    if (wallet.signMessage) {
      signerObj.signMessage = wallet.signMessage.bind(wallet);
    }

    return signerObj;
  }, [wallet.connected, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions, wallet.signMessage]);

  // Initialize SDK
  const initialize = useCallback(async () => {
    if (!signer || !connection) {
      setError(new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet must be connected to initialize SDK'
      ));
      return;
    }

    setIsInitializing(true);
    setError(null);

    try {
      const config: CloakSDKConfig = {
        connection,
        signer,
        relayerUrl,
        altAddress,
        programId,
        verbose,
        circuitPath,
      };

      const newSdk = new CloakSDK(config);
      await newSdk.initialize();

      setSdk(newSdk);
      setIsReady(true);
      currentWalletRef.current = wallet.publicKey?.toBase58() ?? null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to initialize SDK');
      setError(error);
      setSdk(null);
      setIsReady(false);
    } finally {
      setIsInitializing(false);
    }
  }, [signer, connection, relayerUrl, programId, verbose, circuitPath, wallet.publicKey]);

  // Reset SDK
  const reset = useCallback(() => {
    setSdk(null);
    setIsReady(false);
    setIsInitializing(false);
    setError(null);
    currentWalletRef.current = null;
  }, []);

  // Auto-initialize when wallet connects/changes
  useEffect(() => {
    const walletKey = wallet.publicKey?.toBase58() ?? null;

    // Wallet disconnected
    if (!wallet.connected || !walletKey) {
      if (isReady || sdk) {
        reset();
      }
      return;
    }

    // Wallet changed
    if (currentWalletRef.current && currentWalletRef.current !== walletKey) {
      reset();
    }

    // Auto-initialize if enabled and not already initialized
    if (autoInitialize && !isReady && !isInitializing && !error) {
      initialize();
    }
  }, [wallet.connected, wallet.publicKey, autoInitialize, isReady, isInitializing, error, reset, initialize, sdk]);

  return {
    sdk,
    isReady,
    isInitializing,
    error,
    initialize,
    reset,
  };
}

/**
 * Return type for useCloakWallet hook
 */
export interface UseCloakWalletReturn {
  /** Whether wallet is connected */
  connected: boolean;
  /** Wallet public key */
  publicKey: string | null;
  /** TransactionSigner for use with CloakSDK */
  signer: TransactionSigner | null;
  /** Whether wallet supports batch signing */
  supportsBatchSigning: boolean;
  /** Whether wallet supports message signing */
  supportsMessageSigning: boolean;
  /** Generate a signature for UTXO derivation */
  generateSignature: (message?: string) => Promise<Signed>;
}

/**
 * Hook to get wallet info and signer for Cloak SDK
 *
 * Lower-level hook if you want to manage CloakSDK instance yourself.
 *
 * @example
 * ```typescript
 * import { useCloakWallet } from '@cloak-dev/sdk/react';
 * import { CloakSDK } from '@cloak-dev/sdk';
 *
 * function MyComponent() {
 *   const { connected, signer, supportsBatchSigning } = useCloakWallet();
 *   const { connection } = useConnection();
 *
 *   const createSDK = () => {
 *     if (!signer) return null;
 *     return new CloakSDK({ connection, signer, relayerUrl: '...' });
 *   };
 * }
 * ```
 */
export function useCloakWallet(): UseCloakWalletReturn {
  const wallet = useWallet();

  const signer = useMemo((): TransactionSigner | null => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      return null;
    }

    const signerObj: TransactionSigner = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction.bind(wallet),
    };

    if (wallet.signAllTransactions) {
      signerObj.signAllTransactions = wallet.signAllTransactions.bind(wallet);
    }

    if (wallet.signMessage) {
      signerObj.signMessage = wallet.signMessage.bind(wallet);
    }

    return signerObj;
  }, [wallet.connected, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions, wallet.signMessage]);

  const generateSignature = useCallback(async (message?: string): Promise<Signed> => {
    if (!wallet.connected || !wallet.publicKey) {
      throw new ValidationError(
        ErrorCodes.WALLET_NOT_CONNECTED,
        'Wallet not connected'
      );
    }

    if (!wallet.signMessage) {
      throw new ValidationError(
        ErrorCodes.WALLET_SIGNING_NOT_SUPPORTED,
        'Wallet does not support message signing'
      );
    }

    const messageBytes = new TextEncoder().encode(message || 'Cloak Privacy Account');
    const signature = await wallet.signMessage(messageBytes);

    return {
      publicKey: wallet.publicKey,
      signature,
    };
  }, [wallet.connected, wallet.publicKey, wallet.signMessage]);

  return {
    connected: wallet.connected,
    publicKey: wallet.publicKey?.toBase58() ?? null,
    signer,
    supportsBatchSigning: typeof wallet.signAllTransactions === 'function',
    supportsMessageSigning: typeof wallet.signMessage === 'function',
    generateSignature,
  };
}

// Re-export types that users might need
export type { TransactionSigner, Signed, CloakSDKConfig } from '../types';
export { CloakSDK } from '../lib/CloakSDK';
