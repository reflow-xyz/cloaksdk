import { describe, expect, it } from "vitest";
import { parseRelayerError } from "./relayer-client";

describe("parseRelayerError", () => {
	it("extracts string error", async () => {
		const response = new Response(
			JSON.stringify({ error: "bad request" }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
		await expect(parseRelayerError(response)).resolves.toBe(
			"bad request",
		);
	});

	it("extracts message when error is absent", async () => {
		const response = new Response(
			JSON.stringify({ message: "not allowed" }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
		await expect(parseRelayerError(response)).resolves.toBe(
			"not allowed",
		);
	});

	it("falls back to response text for non-json body", async () => {
		const response = new Response("gateway timeout", {
			status: 504,
		});
		await expect(parseRelayerError(response)).resolves.toBe(
			"gateway timeout",
		);
	});
});
