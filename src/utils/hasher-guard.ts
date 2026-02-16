import { ConfigurationError, ErrorCodes } from "../errors";
import type { LightWasm } from "../types/internal";

export function requireHasher(hasher?: LightWasm): LightWasm {
	if (!hasher) {
		throw new ConfigurationError(
			ErrorCodes.HASHER_NOT_INITIALIZED,
			"Hasher not initialized. Call initialize() before operations.",
		);
	}
	return hasher;
}
