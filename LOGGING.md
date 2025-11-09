# SDK Logging Configuration

The Cloak SDK uses a centralized logging system that can be controlled via the `verbose` flag during SDK initialization.

## Usage

### Silent Mode (Default)

By default, the SDK runs in silent mode with no console output:

```typescript
const sdk = new CloakSDK({
  connection,
  signer: keypair,
  verbose: false, // or omit this - false is default
});

await sdk.initialize();
await sdk.depositSol({ amount: 0.1 }); // No logs
```

### Verbose Mode

Enable verbose mode to see detailed logging:

```typescript
const sdk = new CloakSDK({
  connection,
  signer: keypair,
  verbose: true, // Enable logging
});

await sdk.initialize();
// Logs:
// Initializing Cloak SDK...
// Loading Poseidon hasher...
// Hasher loaded successfully
// ...

await sdk.depositSol({ amount: 0.1 });
// Logs:
// Depositing 0.1 SOL...
// Fetching Merkle root and nextIndex from API...
// Using tree root: 0x...
// Generating proof...
// ...
```

## Logger Implementation

The SDK uses a centralized logger module (`src/utils/logger.ts`) with the following functions:

- `log()` - Regular logging (only when verbose=true)
- `warn()` - Warning messages (only when verbose=true)  
- `error()` - Error messages (always shown, even in silent mode)
- `debug()` - Debug messages (only when verbose=true)

## Benefits

1. **Clean Integration** - Users integrating the SDK won't see unwanted console spam
2. **Easy Debugging** - Developers can enable verbose mode to troubleshoot issues
3. **Production Ready** - No logs leak in production unless explicitly enabled
4. **Consistent Behavior** - All SDK modules respect the same verbose flag

## Example Output

### Silent Mode (verbose=false)
```
// No output unless there's an error
```

### Verbose Mode (verbose=true)
```
Initializing Cloak SDK...
Loading Poseidon hasher...
Hasher loaded successfully
Generating account signature...
Account signature generated
SDK initialized successfully

Depositing 0.1 SOL...
Fetching Merkle root and nextIndex from API...
Fetched root from API: 0x1234...
Using tree root: 0x1234...
Creating proof input...
Generating proof... (this may take a minute)
Proof generated successfully
Setting up Address Lookup Table...
Building transaction...
Transaction sent: 5abc...xyz
Deposit successful: 5abc...xyz
```

## Custom Logging

If you want to handle logging yourself, you can use the `onStatus` callback:

```typescript
const sdk = new CloakSDK({
  connection,
  signer: keypair,
  verbose: false, // Silent SDK
});

await sdk.depositSol({
  amount: 0.1,
  onStatus: (status) => {
    // Your custom logging logic
    myLogger.info(`SDK Status: ${status}`);
  },
});
```
