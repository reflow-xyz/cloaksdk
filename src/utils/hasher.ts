import { WasmFactory, type LightWasm } from '@lightprotocol/hasher.rs';

let hasherInstance: LightWasm | null = null;

/**
 * Get the Poseidon hasher instance (singleton)
 *
 * The hasher is required for computing commitments and nullifiers in zero-knowledge proofs.
 * This function lazily initializes the WASM module on first call and caches it.
 *
 * @returns Promise resolving to the Light Protocol hasher instance
 */
export async function getHasher(): Promise<LightWasm> {
  if (hasherInstance) {
    return hasherInstance;
  }

  // WasmFactory.getInstance() is a static method
  hasherInstance = await WasmFactory.getInstance();

  return hasherInstance;
}
