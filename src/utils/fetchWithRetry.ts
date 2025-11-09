import { error, log } from "./logger";

/**
 * Fetch with automatic retry and exponential backoff
 * Handles network failures, timeouts, and transient server errors (5xx)
 * Does NOT retry client errors (4xx) as they won't succeed on retry
 */
export async function fetchWithRetry(
	url: string,
	options?: RequestInit,
	maxRetries: number = 3,
	baseDelayMs: number = 500,
): Promise<Response> {
	let lastError: any;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, options);

			// Success - return immediately
			if (response.ok) {
				return response;
			}

			// Client errors (4xx) won't succeed on retry - fail fast
			if (response.status >= 400 && response.status < 500) {
				return response;
			}

			// Server errors (5xx) - retry with backoff
			if (response.status >= 500) {
				lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);

				if (attempt === maxRetries) {
					error(`❌ Fetch failed after ${maxRetries + 1} attempts:`, lastError);
					throw lastError; // Throw to trigger transaction-level retry
				}

				const delayMs = baseDelayMs * Math.pow(2, attempt);
				error(`⚠️  HTTP ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);

				await new Promise((resolve) => setTimeout(resolve, delayMs));
				continue;
			}

			// Other status codes - return for caller to handle
			return response;

		} catch (err: any) {
			// Network errors - retry with backoff
			lastError = err;

			if (attempt === maxRetries) {
				error(`❌ Network error after ${maxRetries + 1} attempts:`, err);
				throw err;
			}

			const delayMs = baseDelayMs * Math.pow(2, attempt);
			error(`⚠️  Network error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
			log(`Error details:`, err.message);

			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw lastError;
}

/**
 * Fetch JSON with automatic retry
 * Handles both network errors and JSON parsing errors
 */
export async function fetchJsonWithRetry<T>(
	url: string,
	options?: RequestInit,
	maxRetries: number = 3,
): Promise<T> {
	const response = await fetchWithRetry(url, options, maxRetries);

	try {
		return (await response.json()) as T;
	} catch (err: any) {
		error(`❌ Failed to parse JSON response from ${url}:`, err);
		throw new Error(
			`Invalid JSON response from ${url}: ${err.message}`,
		);
	}
}
