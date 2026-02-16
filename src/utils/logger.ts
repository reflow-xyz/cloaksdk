/**
 * Centralized logging utility for the Cloak SDK
 * Only logs when verbose mode is enabled
 */

let isVerbose = false;

export function setVerbose(verbose: boolean) {
  isVerbose = verbose;
}

export function log(...args: unknown[]) {
  if (isVerbose) {
    console.log('[SDK]', ...args);
  }
}

export function warn(...args: unknown[]) {
  if (isVerbose) {
    console.warn('[SDK WARNING]', ...args);
  }
}

export function error(...args: unknown[]) {
  // Always log errors
  console.error('[SDK ERROR]', ...args);
}

export function debug(...args: unknown[]) {
  if (isVerbose) {
    console.log('[SDK DEBUG]', ...args);
  }
}

/**
 * Serializes any error object to a readable string format
 * Handles complex objects, circular references, and Solana transaction errors
 */
export function serializeError(err: unknown): string {
  if (err === null || err === undefined) {
    return String(err);
  }

  // If it's already a string, return it
  if (typeof err === 'string') {
    return err;
  }

  // If it has a message property, start with that
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const errWithMessage = err as { message?: unknown; stack?: unknown; name?: unknown };
    let result = String(errWithMessage.message ?? 'Unknown error');

    // Add stack trace if available
    if (errWithMessage.stack && isVerbose) {
      result += `\n\nStack trace:\n${String(errWithMessage.stack)}`;
    }

    // Try to add any additional properties
    try {
      const additionalProps = Object.getOwnPropertyNames(err)
        .filter(key => key !== 'message' && key !== 'stack' && key !== 'name')
        .reduce((acc, key) => {
          try {
            const value = (err as Record<string, unknown>)[key];
            acc[key] = value;
          } catch {
            acc[key] = '[Unable to serialize]';
          }
          return acc;
        }, {} as Record<string, unknown>);

      if (Object.keys(additionalProps).length > 0) {
        result += `\n\nAdditional details:\n${JSON.stringify(additionalProps, null, 2)}`;
      }
    } catch {
      // If we can't extract additional props, just continue
    }

    return result;
  }

  // For objects without a message, try to stringify
  try {
    // Try to extract all properties including non-enumerable ones
    const allProps = Object.getOwnPropertyNames(err).reduce((acc, key) => {
      try {
        acc[key] = (err as Record<string, unknown>)[key];
      } catch {
        acc[key] = '[Unable to serialize]';
      }
      return acc;
    }, {} as Record<string, unknown>);

    return JSON.stringify(allProps, null, 2);
  } catch {
    // If JSON.stringify fails (circular reference), fallback to String()
    try {
      return String(err);
    } catch {
      return '[Unable to serialize error]';
    }
  }
}
