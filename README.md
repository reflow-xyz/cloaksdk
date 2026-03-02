# @cloak-dev/sdk

Official TypeScript SDK for Cloak Privacy Protocol on Solana.

## Latest updates

- Added high-level transfer workflows: `transfer(...)` and `transferBack(...)`
- Added max-withdrawable estimator: `getMaxTransferableAmount(...)`
- Added SPL batch deposits: `batchDepositSpl(...)`
- Added required configurable ALT support via `altAddress`
- Added wallet adapter helpers and React hooks (`@cloak-dev/sdk/react`)
- Improved withdraw responses with `signatures[]` (batch) and max-withdrawable hints on insufficient balance

## Installation

```bash
npm install @cloak-dev/sdk
# or
pnpm add @cloak-dev/sdk
# or
yarn add @cloak-dev/sdk
```

## Required configuration

`CloakSDK` now requires:

- `connection`: Solana `Connection`
- `relayerUrl`: Cloak relayer base URL
- `altAddress`: Address Lookup Table for your cluster

Known ALT addresses:

- Mainnet: `G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj`
- Devnet: `Dy1kWrcceThLo9ywoMH2MpWTsBe9pxsv3fCcTj3sSDK9`

## Quick start

```ts
import { CloakSDK, Connection, Keypair, LAMPORTS_PER_SOL } from '@cloak-dev/sdk';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const keypair = Keypair.fromSecretKey(secretKeyBytes);

const sdk = new CloakSDK({
  connection,
  relayerUrl: 'https://your-relayer-url',
  altAddress: 'G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj',
  verbose: false,
});

sdk.setSigner(keypair);
await sdk.initialize();

const deposit = await sdk.depositSol({ amount: 0.01 });
if (!deposit.success) throw new Error(deposit.error);

const bal = await sdk.getSolBalance();
console.log('Private SOL:', bal.total.toNumber() / LAMPORTS_PER_SOL);
```

## API overview

### Core SOL

- `depositSol(options: DepositOptions): Promise<DepositResult>`
- `withdrawSol(options: WithdrawOptions): Promise<WithdrawResult>`
- `batchDepositSol(options: BatchDepositOptions): Promise<BatchDepositResult>`

### Core SPL

- `depositSpl(options: DepositSplOptions): Promise<DepositResult>`
- `withdrawSpl(options: WithdrawSplOptions): Promise<WithdrawResult>`
- `batchDepositSpl(options: BatchDepositSplOptions): Promise<BatchDepositResult>`

### Transfers and automation

- `fullTransfer({ depositAmount, withdrawAmount, recipientAddress?, waitSeconds?, onStatus? })`
- `transfer(options: TransferOptions): Promise<TransferResult>`
- `transferBack(keypairs, options?): Promise<TransferBackResult>`

### Balances and cache

- `getSolBalance(utxoWalletSigned?, forceRefresh?, signer?)`
- `getSplBalance(mintAddress, utxoWalletSigned?, forceRefresh?, signer?)`
- `batchBalanceCheck(keypairs)`
- `refreshUtxos()`
- `clearCache()`

### Estimation

- `getMaxTransferableAmount(options?: MaxTransferableOptions)`
- `getMaxTransferrableAmount(options?)` (backward-compatible alias)

### Signer management

- `setSigner(signer)`
- `clearSigner()`
- `getPublicKey()`
- `getConnection()`

## API reference

### Core SOL

#### `depositSol(options: DepositOptions): Promise<DepositResult>`

Parameters:
- `options.amount`: SOL amount to deposit.
- `options.signer?`: per-call signer override (`TransactionSigner | Keypair`).
- `options.consolidate?`: if `true`, consolidate existing UTXOs into this deposit.
- `options.onStatus?`: status callback.
- `options.maxRetries?`: retry attempts (default `3`).
- `options.utxoWalletSigned?`: alternate UTXO identity.
- `options.utxoWalletSignTransaction?`: required when using alternate UTXO identity for deposits.

Returns (`DepositResult`):
- `success`: boolean.
- `signature?`: transaction signature.
- `error?`: error message.

#### `withdrawSol(options: WithdrawOptions): Promise<WithdrawResult>`

Parameters:
- `options.recipientAddress`: destination wallet (`PublicKey | string`).
- `options.amount`: SOL amount to withdraw.
- `options.signer?`: per-call signer override.
- `options.delayMinutes?`: delayed withdrawal (0 or omitted = immediate).
- `options.onStatus?`: status callback.
- `options.maxRetries?`: retry attempts (default `3`).
- `options.utxoWalletSigned?`: alternate UTXO identity.
- `options.utxoWalletSignTransaction?`: API-compatible field (not currently used for withdraw signing).
- `options.providedUtxos?`: explicit UTXO set for advanced/batch strategies.

Returns (`WithdrawResult`):
- `isPartial`: whether execution was partial.
- `success?`: success flag.
- `signature?`: immediate tx signature (or first signature in multi-tx withdrawal).
- `signatures?`: all signatures when withdrawal is split across multiple txs.
- `delayedWithdrawalId?`: delayed job ID.
- `executeAt?`: delayed execution timestamp (ISO string).
- `maxWithdrawableAmount?`: fee-aware SOL ceiling when requested amount is too large.
- `maxWithdrawableLamports?`: exact lamports ceiling when requested amount is too large.
- `error?`: error message.

#### `batchDepositSol(options: BatchDepositOptions): Promise<BatchDepositResult>`

Parameters:
- `options.amount`: total SOL to split by denomination.
- `options.signer?`: per-call signer override.
- `options.onStatus?`: status callback.
- `options.maxRetries?`: retry attempts.
- `options.utxoWalletSigned?`: alternate UTXO identity.
- `options.utxoWalletSignTransaction?`: optional UTXO wallet tx signer.

Notes:
- Requires signer support for `signAllTransactions`.
- Generates multiple proof/tx builds, signs once, then submits sequentially.

Returns (`BatchDepositResult`):
- `success`: whether at least one deposit succeeded.
- `signatures`: submitted transaction signatures.
- `successCount`: number of successful deposits.
- `totalCount`: number of planned deposits.
- `error?`: summary error if not fully successful.

### Core SPL

#### `depositSpl(options: DepositSplOptions): Promise<DepositResult>`

`DepositSplOptions` is `DepositOptions` plus:
- `mintAddress`: SPL mint address.

Return shape is `DepositResult` (same as `depositSol`).

#### `withdrawSpl(options: WithdrawSplOptions): Promise<WithdrawResult>`

`WithdrawSplOptions` is `WithdrawOptions` plus:
- `mintAddress`: SPL mint address.

Return shape is `WithdrawResult` (same as `withdrawSol`, except max-withdrawable fields are SOL-specific hints from `withdrawSol`).

#### `batchDepositSpl(options: BatchDepositSplOptions): Promise<BatchDepositResult>`

`BatchDepositSplOptions` is `BatchDepositOptions` plus:
- `mintAddress`: SPL mint address.

Return shape is `BatchDepositResult` (same as `batchDepositSol`).

### Transfers and automation

#### `fullTransfer({ depositAmount, withdrawAmount, recipientAddress?, waitSeconds?, onStatus? })`

Parameters:
- `depositAmount`: SOL to deposit first.
- `withdrawAmount`: SOL to withdraw after deposit.
- `recipientAddress?`: withdrawal recipient (`PublicKey | string`); defaults to active signer.
- `waitSeconds?`: compatibility field used to derive delay minutes.
- `onStatus?`: status callback.

Returns:
- `{ depositResult: DepositResult, withdrawResult: WithdrawResult }`.

#### `transfer(options: TransferOptions): Promise<TransferResult>`

Parameters (`TransferOptions`):
- `in`: source `Keypair[]` (private balances are read from these).
- `out`: destination `Keypair[]`.
- `amount`: total SOL requested.
- `bps?`: destination split map (`Map<Keypair | PublicKey | string, number>`).
- `delay?`: delay minutes per withdrawal leg.
- `onStatus?`: status callback.
- `maxRetries?`: retry attempts per leg.

Returns (`TransferResult`):
- `success`: all legs succeeded and attempted amount fully transferred.
- `requestedAmount`: original requested SOL.
- `attemptedAmount`: amount attempted after availability checks.
- `legs`: per-leg transfer results.
- `error?`: planning/execution summary error.

#### `transferBack(keypairs, options?): Promise<TransferBackResult>`

Parameters:
- `keypairs`: source keypairs to sweep back to active SDK signer.
- `options.redepositToPool?`: redeposit swept SOL into signer's Cloak pool.
- `options.onStatus?`: status callback.

Returns (`TransferBackResult`):
- `success`: overall transfer-back success.
- `entries`: per-keypair details (canceled delayed jobs, fee-aware max, withdraw result).
- `transferredBackAmount?`: total SOL sent back to signer wallet.
- `redepositResult?`: optional deposit result when `redepositToPool` is enabled.
- `error?`: early failure message.

### Balances and cache

#### `getSolBalance(utxoWalletSigned?, forceRefresh?, signer?)`

Parameters:
- `utxoWalletSigned?`: explicit UTXO identity.
- `forceRefresh?`: bypass cache and fetch fresh UTXOs (default `false`).
- `signer?`: signer override if no explicit signed identity is passed.

Returns:
- `Promise<UtxoBalance>` with lamports total (`BN`), UTXO count, and SOL mint id.

#### `getSplBalance(mintAddress, utxoWalletSigned?, forceRefresh?, signer?)`

Parameters:
- `mintAddress`: SPL mint to query.
- `utxoWalletSigned?`: explicit UTXO identity.
- `forceRefresh?`: bypass cache and fetch fresh UTXOs (default `false`).
- `signer?`: signer override.

Returns:
- `Promise<UtxoBalance>` with base-unit total (`BN`) and count for the mint.

#### `batchBalanceCheck(keypairs)`

Parameters:
- `keypairs`: array of `Keypair`.

Returns:
- `Promise<BatchBalanceEntry[]>` where each item is `{ publicKey, balance }`.

#### `refreshUtxos()`

Returns:
- Array of refreshed UTXO objects after clearing and refetching cache/state.

#### `clearCache()`

Returns:
- `void`. Clears internal UTXO cache.

### Estimation

#### `getMaxTransferableAmount(options?: MaxTransferableOptions)`

Parameters:
- `numberOfWithdrawals?`: withdrawal count assumed for fixed costs (default `1`).
- `withdrawFeeRatePercent?`: variable fee percent override (default protocol value).
- `fixedCostPerWithdrawalSol?`: fixed per-withdrawal SOL overhead override.
- `forceRefresh?`: force fresh source balance read (default `true`).
- `signer?`: signer override.
- `utxoWalletSigned?`: signed UTXO identity override.

Returns (`MaxTransferableResult`):
- `maxTransferableAmount`, `maxTransferableLamports`
- `availableAmount`, `availableLamports`
- `numberOfWithdrawals`, `withdrawFeeRatePercent`
- `fixedCostPerWithdrawalSol`, `totalFixedCostSol`, `totalFixedCostLamports`
- `estimatedVariableFeeSol`, `estimatedVariableFeeLamports`
- `estimatedTotalFeeSol`, `estimatedTotalFeeLamports`

#### `getMaxTransferrableAmount(options?)`

- Backward-compatible alias of `getMaxTransferableAmount`.

### Signer management

#### `setSigner(signer)`

Parameters:
- `signer`: `TransactionSigner | Keypair`.

Returns:
- `void`. Sets/replaces active signer for subsequent operations.

#### `clearSigner()`

Returns:
- `void`. Clears active signer and signer-derived caches.

#### `getPublicKey()`

Returns:
- `PublicKey` of active signer.

Throws:
- Configuration error if signer is not configured.

#### `getConnection()`

Returns:
- Current Solana `Connection` used by the SDK.

## Common examples

### Withdraw with max-withdrawable fallback

```ts
const requested = 0.25;
let res = await sdk.withdrawSol({
  recipientAddress: sdk.getPublicKey(),
  amount: requested,
});

if (!res.success && typeof res.maxWithdrawableAmount === 'number' && res.maxWithdrawableAmount > 0) {
  res = await sdk.withdrawSol({
    recipientAddress: sdk.getPublicKey(),
    amount: res.maxWithdrawableAmount,
  });
}

if (!res.success) throw new Error(res.error);
console.log('Signature:', res.signature);
```

### Delayed withdrawal

```ts
const delayed = await sdk.withdrawSol({
  recipientAddress: sdk.getPublicKey(),
  amount: 0.1,
  delayMinutes: 30,
});

if (delayed.success) {
  console.log(delayed.delayedWithdrawalId); // string
  console.log(delayed.executeAt);           // ISO timestamp
}
```

### SPL deposit/withdraw

```ts
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

await sdk.depositSpl({ amount: 1_000_000, mintAddress: USDC_MINT }); // 1 USDC (6 decimals)
await sdk.withdrawSpl({
  recipientAddress: sdk.getPublicKey(),
  amount: 500_000,
  mintAddress: USDC_MINT,
});
```

### Transfer between private wallets

```ts
const result = await sdk.transfer({
  in: [sourceA, sourceB],
  out: [destA, destB],
  amount: 1.2,
  delay: 0,
});

if (!result.success) {
  console.error(result.error);
}
```

### Transfer back to active signer

```ts
const result = await sdk.transferBack([sourceA, sourceB], {
  redepositToPool: false,
});

console.log(result.transferredBackAmount);
```

### Estimate max transferable SOL

```ts
const estimate = await sdk.getMaxTransferableAmount({
  numberOfWithdrawals: 2,
});

console.log(estimate.maxTransferableAmount);
console.log(estimate.estimatedTotalFeeSol);
```

## Multi-wallet UTXO signature usage

For advanced flows, you can derive UTXOs from a different wallet identity:

```ts
import { generateUtxoWalletSignature } from '@cloak-dev/sdk';

const utxoWalletSigned = await generateUtxoWalletSignature(utxoKeypair);

await sdk.depositSol({
  amount: 0.01,
  utxoWalletSigned,
  utxoWalletSignTransaction: async (tx) => {
    tx.sign([fundingKeypair]);
    return tx;
  },
});
```

## Batch planning utilities

Exported helpers:

- `planBatchDeposits`, `previewBatchDeposit`
- `planBatchSplDeposits`, `previewBatchSplDeposit`
- `planBatchWithdrawals`, `previewBatchWithdrawal`

```ts
import { previewBatchDeposit } from '@cloak-dev/sdk';

const preview = previewBatchDeposit(2.5);
if (preview) {
  console.log(preview.numTransactions);
  console.log(preview.breakdown);
}
```

## Wallet adapter integration

Utilities exported from the main package:

- `WalletConnector`
- `createSignerFromAdapter`
- `isSignableAdapter`
- `supportsBatchSigning`
- `supportsMessageSigning`

```ts
import { CloakSDK, createSignerFromAdapter } from '@cloak-dev/sdk';

const signer = createSignerFromAdapter(walletAdapter);
const sdk = new CloakSDK({
  connection,
  relayerUrl: 'https://your-relayer-url',
  altAddress: 'G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj',
});
sdk.setSigner(signer);
await sdk.initialize();
```

## React integration

Install peers if needed:

```bash
npm install @solana/wallet-adapter-react react
```

Use the React hook package entrypoint:

```ts
import { useCloakSDK } from '@cloak-dev/sdk/react';

const { sdk, isReady, error } = useCloakSDK({
  relayerUrl: 'https://your-relayer-url',
  altAddress: 'G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj',
});
```

## Error handling

The SDK exposes typed errors and helpers:

- `ErrorCodes`
- `CloakError`, `ValidationError`, `NetworkError`, `TransactionError`, `EncryptionError`, `ConfigurationError`, `ProofError`
- `isCloakError`, `hasErrorCode`, `wrapError`

```ts
import { isCloakError, ErrorCodes } from '@cloak-dev/sdk';

try {
  await sdk.depositSol({ amount: 0.1 });
} catch (err) {
  if (isCloakError(err) && err.code === ErrorCodes.INSUFFICIENT_BALANCE) {
    console.error('Top up wallet balance first.');
  }
}
```

## Fees

- Deposit fee: `0%`
- Withdraw fee: `0.3%`

## Development

```bash
npm run build
npm run typecheck
npm run test
npm run check
```

## Links

- Repository: `https://github.com/reflow-xyz/cloaksdk`
- Issues: `https://github.com/reflow-xyz/cloaksdk/issues`
