# @cloak-labs/sdk

Official SDK for the Cloak Privacy Protocol on Solana. Deposit and withdraw SOL and SPL tokens with zero-knowledge proof privacy guarantees.

## Features

- **Privacy-Preserving Transfers**: Zero-knowledge proofs ensure transaction privacy
- **SOL Support**: Deposit and withdraw native SOL
- **SPL Token Support**: Full support for SPL tokens (USDC, USDT, etc.)
- **Delayed Withdrawals**: Optional delayed withdrawals for enhanced security
- **Keypair-Based**: Simple initialization with Solana Keypair
- **TypeScript**: Full TypeScript support with comprehensive types
- **Production Ready**: Built on audited smart contracts

## Installation

```bash
npm install @cloak-labs/sdk

# or
yarn add @cloak-labs/sdk

# or
pnpm add @cloak-labs/sdk
```

## Quick Start

```typescript
import { CloakSDK, Connection, Keypair } from '@cloak-labs/sdk';

// Initialize connection and keypair
const connection = new Connection('https://api.devnet.solana.com');
const keypair = Keypair.fromSecretKey(secretKeyBytes);

// Create SDK instance
const sdk = new CloakSDK({
  connection,
  signer: keypair,
  verbose: true // Optional: enable logging
});

// Initialize SDK (required before use)
await sdk.initialize();

// Now you can use all SDK functions
```

## API Reference

### Constructor

#### `new CloakSDK(config: CloakSDKConfig)`

Creates a new SDK instance.

**Parameters:**
- `config.connection` (Connection): Solana connection instance
- `config.signer` (TransactionSigner | Keypair): User's Solana keypair or wallet adapter for signing transactions
- `config.relayerUrl` (string, optional): Custom relayer URL. Defaults to production relayer
- `config.programId` (string, optional): Custom program ID. Defaults to mainnet program
- `config.verbose` (boolean, optional): Enable verbose logging. Default: false

### Initialization

#### `await sdk.initialize()`

Initializes the SDK by loading the Poseidon hasher and generating account signatures.
**Must be called before any other operations.**

```typescript
await sdk.initialize();
```

### SOL Operations

#### `await sdk.depositSol(options: DepositOptions): Promise<DepositResult>`

Deposit SOL into the privacy pool.

**Parameters:**
- `options.amount` (number): Amount in SOL (e.g., 0.5 for half a SOL)
- `options.onStatus` ((status: string) => void, optional): Callback for status updates

**Returns:** `DepositResult`
- `success` (boolean): Whether deposit succeeded
- `signature` (string, optional): Transaction signature
- `error` (string, optional): Error message if failed

**Example:**
```typescript
const result = await sdk.depositSol({
  amount: 0.5,
  onStatus: (status) => console.log('Status:', status)
});

if (result.success) {
  console.log('Deposit successful:', result.signature);
  console.log(`View on explorer: https://explorer.solana.com/tx/${result.signature}`);
}
```

#### `await sdk.withdrawSol(options: WithdrawOptions): Promise<WithdrawResult>`

Withdraw SOL from the privacy pool.

**Parameters:**
- `options.recipientAddress` (PublicKey | string): Recipient's wallet address
- `options.amount` (number): Amount in SOL to withdraw
- `options.delayMinutes` (number, optional): Delay before execution (0 for immediate). Max: 10080 (7 days)
- `options.onStatus` ((status: string) => void, optional): Callback for status updates

**Returns:** `WithdrawResult`
- `isPartial` (boolean): Whether withdrawal was partial (insufficient balance)
- `success` (boolean): Whether withdrawal succeeded
- `signature` (string, optional): Transaction signature (for immediate withdrawals)
- `delayedWithdrawalId` (number, optional): ID for delayed withdrawals
- `executeAt` (string, optional): ISO timestamp when delayed withdrawal will execute
- `error` (string, optional): Error message if failed

**Example (Immediate):**
```typescript
const result = await sdk.withdrawSol({
  recipientAddress: 'recipient-pubkey-here',
  amount: 0.3,
});

if (result.success) {
  console.log('Withdrawal successful!');
  if (result.isPartial) {
    console.log('Note: Partial withdrawal due to insufficient balance');
  }
}
```

**Example (Delayed):**
```typescript
const result = await sdk.withdrawSol({
  recipientAddress: new PublicKey('...'),
  amount: 0.3,
  delayMinutes: 30, // Execute after 30 minutes
});

if (result.success) {
  console.log('Withdrawal scheduled!');
  console.log('ID:', result.delayedWithdrawalId);
  console.log('Will execute at:', result.executeAt);
}
```

### SPL Token Operations

#### `await sdk.depositSpl(options: DepositSplOptions): Promise<DepositResult>`

Deposit SPL tokens into the privacy pool.

**Parameters:**
- `options.amount` (number): Amount in base units (e.g., 1000000 for 1 USDC with 6 decimals)
- `options.mintAddress` (string): SPL token mint address
- `options.onStatus` ((status: string) => void, optional): Callback for status updates

**Example:**
```typescript
// Deposit 1 USDC (6 decimals)
const result = await sdk.depositSpl({
  amount: 1_000_000,
  mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mint
  onStatus: (status) => console.log(status)
});

if (result.success) {
  console.log('USDC deposit successful:', result.signature);
}
```

#### `await sdk.withdrawSpl(options: WithdrawSplOptions): Promise<WithdrawResult>`

Withdraw SPL tokens from the privacy pool.

**Parameters:**
- `options.recipientAddress` (PublicKey | string): Recipient's wallet address
- `options.amount` (number): Amount in base units
- `options.mintAddress` (string): SPL token mint address
- `options.delayMinutes` (number, optional): Delay before execution
- `options.onStatus` ((status: string) => void, optional): Callback for status updates

**Example:**
```typescript
// Immediate SPL withdrawal
const result = await sdk.withdrawSpl({
  recipientAddress: 'recipient-pubkey-here',
  amount: 500_000, // 0.5 USDC
  mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
});

// Delayed SPL withdrawal
const delayedResult = await sdk.withdrawSpl({
  recipientAddress: new PublicKey('...'),
  amount: 500_000,
  mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  delayMinutes: 60, // Execute after 1 hour
});
```

### Balance Queries

#### `await sdk.getSolBalance(): Promise<UtxoBalance>`

Get your SOL balance in the privacy pool.

**Returns:** `UtxoBalance`
- `total` (BN): Total balance in lamports
- `count` (number): Number of UTXOs
- `mintAddress` (string): Mint address

**Example:**
```typescript
const balance = await sdk.getSolBalance();
console.log('SOL balance:', balance.total.toNumber() / 1e9, 'SOL');
console.log('Number of UTXOs:', balance.count);
```

#### `await sdk.getSplBalance(mintAddress: string): Promise<UtxoBalance>`

Get your SPL token balance in the privacy pool.

**Parameters:**
- `mintAddress` (string): SPL token mint address

**Example:**
```typescript
const usdcBalance = await sdk.getSplBalance('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
console.log('USDC balance:', usdcBalance.total.toNumber() / 1e6);
console.log('Number of UTXOs:', usdcBalance.count);
```

### Utility Methods

#### `sdk.getPublicKey(): PublicKey`

Get the user's public key.

#### `sdk.getConnection(): Connection`

Get the Solana connection instance.

## Complete Example

```typescript
import { CloakSDK, Connection, Keypair, LAMPORTS_PER_SOL } from '@cloak-labs/sdk';
import fs from 'fs';

async function main() {
  // Load keypair from file
  const secretKey = JSON.parse(
    fs.readFileSync('/path/to/keypair.json', 'utf-8')
  );
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));

  // Initialize SDK
  const connection = new Connection('https://api.devnet.solana.com');
  const sdk = new CloakSDK({
    connection,
    signer: keypair,
    verbose: true,
  });

  await sdk.initialize();
  console.log('SDK initialized with wallet:', sdk.getPublicKey().toString());

  // Check current balance
  const balance = await sdk.getSolBalance();
  console.log('Current privacy pool balance:', balance.total.toNumber() / LAMPORTS_PER_SOL, 'SOL');

  // Deposit SOL
  console.log('\nDepositing 0.1 SOL...');
  const depositResult = await sdk.depositSol({
    amount: 0.1,
    onStatus: (status) => console.log('  →', status),
  });

  if (!depositResult.success) {
    console.error('Deposit failed:', depositResult.error);
    return;
  }

  console.log('Deposit successful:', depositResult.signature);

  // Wait a bit for relayer to update
  console.log('\nWaiting for relayer to update...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Check updated balance
  const newBalance = await sdk.getSolBalance();
  console.log('New privacy pool balance:', newBalance.total.toNumber() / LAMPORTS_PER_SOL, 'SOL');

  // Withdraw with delay
  console.log('\nScheduling withdrawal of 0.05 SOL (30 minute delay)...');
  const withdrawResult = await sdk.withdrawSol({
    recipientAddress: sdk.getPublicKey(), // Withdraw to self
    amount: 0.05,
    delayMinutes: 30,
    onStatus: (status) => console.log('  →', status),
  });

  if (!withdrawResult.success) {
    console.error('Withdrawal scheduling failed:', withdrawResult.error);
    return;
  }

  console.log('Withdrawal scheduled!');
  console.log('  ID:', withdrawResult.delayedWithdrawalId);
  console.log('  Will execute at:', withdrawResult.executeAt);
}

main().catch(console.error);
```

## Error Handling

```typescript
try {
  const result = await sdk.depositSol({ amount: 0.5 });

  if (!result.success) {
    console.error('Deposit failed:', result.error);
    // Handle specific errors
    if (result.error?.includes('Insufficient balance')) {
      console.log('You need more SOL in your wallet');
    }
  }
} catch (error) {
  console.error('Unexpected error:', error);
}
```

## Common SPL Token Mint Addresses

- **USDC**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **USDT**: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`
- **SOL (native)**: Use `depositSol`/`withdrawSol` methods instead

## Fee Structure

- **Deposit Fee**: 0.3% of deposit amount
- **Withdrawal Fee**: 0.3% of withdrawal amount

Fees are automatically deducted from the transaction amounts.

## Security Considerations

1. **Keypair Safety**: Never share or commit your secret key
2. **Delayed Withdrawals**: Use delays for large amounts to detect unauthorized access
3. **Balance Verification**: Always check balances before operations
4. **Error Handling**: Implement proper error handling in production

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```typescript
import type {
  CloakSDKConfig,
  DepositOptions,
  DepositResult,
  WithdrawOptions,
  WithdrawResult,
  UtxoBalance,
} from '@cloak-labs/sdk';
```

## Building from Source

```bash
# Clone the repository
git clone https://github.com/reflow-xyz/cloaksdk
cd cloak-sdk/

# Install dependencies
pnpm install

# Build
ts-node example.ts
```

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/reflow-xyz/cloaksdk/issues)
- **Documentation**: [Full protocol documentation](https://cloaklabs.dev/docs)
