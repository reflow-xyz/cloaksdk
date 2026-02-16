import { describe, expect, it } from "vitest";
import { requireHasher } from "./hasher-guard";
import { ConfigurationError, ErrorCodes } from "../errors";
import type { LightWasm } from "../types/internal";

function createHasherStub(): LightWasm {
	return {
		poseidonHash: () => new Uint8Array([1]),
		poseidonHashString: () => "1",
		poseidonHashBN: () => {
			throw new Error("not used in test");
		},
		blakeHash: () => new Uint8Array([1]),
	};
}

describe("requireHasher", () => {
	it("returns hasher when provided", () => {
		const hasher = createHasherStub();
		expect(requireHasher(hasher)).toBe(hasher);
	});

	it("throws ConfigurationError when missing", () => {
		try {
			requireHasher(undefined);
			throw new Error("expected requireHasher to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect((error as ConfigurationError).code).toBe(
				ErrorCodes.HASHER_NOT_INITIALIZED,
			);
		}
	});
});
