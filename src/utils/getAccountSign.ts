import { Keypair, PublicKey } from '@solana/web3.js';
import * as nacl from 'tweetnacl';

export type Signed = {
  publicKey: PublicKey;
  signature: Uint8Array;
};

/**
 * Generate account signature using a Keypair
 *
 * This function signs a deterministic message with the provided keypair
 * to generate a signature that can be used for encryption/decryption.
 *
 * @param keypair - The Solana keypair to sign with
 * @returns Promise resolving to signed data
 */
export async function getAccountSign(keypair: Keypair): Promise<Signed> {
  const message = 'Cloak Labs Verification Signature';
  const encodedMessage = new TextEncoder().encode(message);

  // Sign the message using the keypair's secret key
  const signature = nacl.sign.detached(encodedMessage, keypair.secretKey);

  return {
    signature,
    publicKey: keypair.publicKey,
  };
}

/**
 * Generate UTXO wallet signature from a Keypair
 *
 * Helper function to generate a Signed object from a Keypair for use with
 * utxoWalletSigned parameter in deposit/withdraw operations.
 *
 * @param keypair - The Solana keypair to generate signature from
 * @returns Promise resolving to Signed object that can be passed to deposit/withdraw
 *
 * @example
 * ```typescript
 * import { Keypair } from '@solana/web3.js';
 * import { generateUtxoWalletSignature } from './utils/getAccountSign';
 *
 * const utxoKeypair = Keypair.generate();
 * const utxoWalletSigned = await generateUtxoWalletSignature(utxoKeypair);
 *
 * await sdk.depositSol({
 *   amount: 0.1,
 *   utxoWalletSigned // Use different wallet for UTXO derivation
 * });
 * ```
 */
export async function generateUtxoWalletSignature(keypair: Keypair): Promise<Signed> {
  return getAccountSign(keypair);
}
