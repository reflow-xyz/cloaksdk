export function isUserRejectedError(err: unknown): boolean {
  if (!err) return false;

  const anyErr = err as any;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";

  // Common EIP-1193 style user rejection code, used by many wallet adapters.
  if (anyErr?.code === 4001) return true;
  if (anyErr?.error?.code === 4001) return true;

  // Wallet adapter error class names.
  const name = typeof anyErr?.name === "string" ? anyErr.name : "";
  if (name.includes("WalletSignTransactionError")) return true;
  if (name.includes("WalletSendTransactionError")) return true;

  if (/user rejected/i.test(message)) return true;
  if (/rejected the request/i.test(message)) return true;

  return false;
}

