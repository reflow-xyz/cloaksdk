# @cloak-dev/sdk

Official TypeScript SDK for Cloak Privacy Protocol on Solana.

## Latest updates

- Added high-level transfer workflows: `transfer(...)` and `transferBack(...)`
- Added max-withdrawable estimator: `getMaxTransferableAmount(...)`
- Added timed withdrawal management helpers: `getAllTimedWithdrawals(...)`, `cancelTimedWithdrawal(...)`, `cancelManyTimedWithdrawals(...)`, `cancelAllTimedWithdrawals(...)`
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

### Timed withdrawal management

- `getAllTimedWithdrawals(options?: TimedWithdrawalQueryOptions): Promise<TimedWithdrawal[]>`
- `cancelTimedWithdrawal(id: number, options?: CancelTimedWithdrawalOptions): Promise<CancelTimedWithdrawalResult>`
- `cancelManyTimedWithdrawals(ids: number[], options?: CancelManyTimedWithdrawalsOptions): Promise<CancelManyTimedWithdrawalsResult>`
- `cancelAllTimedWithdrawals(options?: CancelAllTimedWithdrawalsOptions): Promise<CancelAllTimedWithdrawalsResult>`

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

### Manage pending timed withdrawals

```ts
// List all pending timed withdrawals for current signer
const pending = await sdk.getAllTimedWithdrawals({ type: 'all' });

// Cancel one by numeric ID
if (pending.length > 0) {
  const one = await sdk.cancelTimedWithdrawal(pending[0].id);
  if (!one.success) console.error(one.error);
}

// Cancel many IDs at once
const ids = pending.slice(0, 3).map((w) => w.id);
const many = await sdk.cancelManyTimedWithdrawals(ids);
console.log(many.canceled, many.requested);

// Cancel all pending SPL timed withdrawals for the signer
const allSpl = await sdk.cancelAllTimedWithdrawals({ type: 'spl' });
console.log(allSpl.totalPending, allSpl.canceled);
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
