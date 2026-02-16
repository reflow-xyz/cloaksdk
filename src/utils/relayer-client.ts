import { ErrorCodes, NetworkError } from "../errors";
import { fetchWithRetry } from "./fetchWithRetry";

export async function parseRelayerError(response: Response): Promise<string> {
	const rawBody = await response.text();

	try {
		const errorData = JSON.parse(rawBody) as {
			error?: unknown;
			message?: unknown;
		};

		if (typeof errorData.error === "string") {
			return errorData.error;
		}
		if (typeof errorData.message === "string") {
			return errorData.message;
		}
		if (errorData.error !== undefined) {
			return JSON.stringify(errorData.error, null, 2);
		}
		return JSON.stringify(errorData, null, 2);
	} catch {
		return rawBody;
	}
}

export async function postRelayerJson<T>(
	relayerUrl: string,
	path: string,
	payload: unknown,
	errorPrefix: string,
	maxRetries: number = 3,
): Promise<T> {
	const endpoint = `${relayerUrl}${path}`;
	const response = await fetchWithRetry(
		endpoint,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		maxRetries,
	);

	if (!response.ok) {
		const errorMsg = await parseRelayerError(response);
		throw new NetworkError(
			ErrorCodes.RELAYER_ERROR,
			`${errorPrefix} (${response.status}): ${errorMsg}`,
			{
				endpoint,
				statusCode: response.status,
			},
		);
	}

	return (await response.json()) as T;
}
