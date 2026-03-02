import { beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { CloakSDK } from "./CloakSDK";
import { fetchWithRetry } from "../utils/fetchWithRetry";

vi.mock("../utils/fetchWithRetry", () => ({
	fetchWithRetry: vi.fn(),
}));

const fetchWithRetryMock = vi.mocked(fetchWithRetry);

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function createSdk() {
	const sdk = new CloakSDK({
		connection: new Connection("http://localhost:8899", "confirmed"),
		relayerUrl: "https://relayer.test",
		altAddress: "11111111111111111111111111111111",
	});
	const signer = Keypair.generate();
	sdk.setSigner(signer);
	(sdk as unknown as { initialized: boolean }).initialized = true;
	return { sdk, signer };
}

describe("CloakSDK timed withdrawals", () => {
	beforeEach(() => {
		fetchWithRetryMock.mockReset();
	});

	it("gets all timed withdrawals across SOL and SPL", async () => {
		const { sdk, signer } = createSdk();
		const pubkey = signer.publicKey.toBase58();

		fetchWithRetryMock
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 11,
							type: "sol",
							delayedWithdrawalId: "sol-11",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 15,
							executeAt: "2026-01-01T00:00:00.000Z",
							status: "pending",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 22,
							type: "spl",
							delayedWithdrawalId: "spl-22",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 30,
							executeAt: "2026-02-01T00:00:00.000Z",
							status: "pending",
							mintAddress: "mint-1",
						},
					],
				}),
			);

		const withdrawals = await sdk.getAllTimedWithdrawals();

		expect(withdrawals).toHaveLength(2);
		expect(withdrawals.map((w) => w.id)).toEqual([22, 11]);
		expect(withdrawals[0].type).toBe("spl");
		expect(withdrawals[1].type).toBe("sol");
		expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
			1,
			`https://relayer.test/withdraw/delayed/user/${encodeURIComponent(pubkey)}`,
			undefined,
			3,
		);
		expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
			2,
			`https://relayer.test/withdraw/spl/delayed/user/${encodeURIComponent(pubkey)}`,
			undefined,
			3,
		);
	});

	it("cancels one timed withdrawal by auto-detected type", async () => {
		const { sdk, signer } = createSdk();
		const pubkey = signer.publicKey.toBase58();

		fetchWithRetryMock
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 7,
							type: "spl",
							delayedWithdrawalId: "spl-7",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 5,
							executeAt: "2026-02-10T00:00:00.000Z",
							status: "pending",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					message: "Delayed SPL withdrawal cancelled",
				}),
			);

		const result = await sdk.cancelTimedWithdrawal(7);

		expect(result).toEqual({
			id: 7,
			type: "spl",
			success: true,
			message: "Delayed SPL withdrawal cancelled",
		});
		expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
			3,
			"https://relayer.test/withdraw/spl/delayed/7",
			{ method: "DELETE" },
			3,
		);
	});

	it("cancels many timed withdrawals and reports partial failures", async () => {
		const { sdk, signer } = createSdk();
		const pubkey = signer.publicKey.toBase58();

		fetchWithRetryMock
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 1,
							type: "sol",
							delayedWithdrawalId: "sol-1",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 5,
							executeAt: "2026-02-10T00:00:00.000Z",
							status: "pending",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 2,
							type: "spl",
							delayedWithdrawalId: "spl-2",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 15,
							executeAt: "2026-02-10T01:00:00.000Z",
							status: "pending",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					message: "Delayed withdrawal cancelled",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse(
					{
						error: "internal",
					},
					500,
				),
			);

		const result = await sdk.cancelManyTimedWithdrawals([1, 2, 3]);

		expect(result.success).toBe(false);
		expect(result.requested).toBe(3);
		expect(result.canceled).toBe(1);
		expect(result.results).toEqual([
			{
				id: 1,
				type: "sol",
				success: true,
				message: "Delayed withdrawal cancelled",
			},
			{
				id: 2,
				type: "spl",
				success: false,
				error: "500: internal",
			},
			{
				id: 3,
				success: false,
				error: "Timed withdrawal 3 not found",
			},
		]);
	});

	it("cancels all timed withdrawals for a specific type", async () => {
		const { sdk, signer } = createSdk();
		const pubkey = signer.publicKey.toBase58();

		fetchWithRetryMock
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					withdrawals: [
						{
							id: 101,
							type: "sol",
							delayedWithdrawalId: "sol-101",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 10,
							executeAt: "2026-02-10T01:00:00.000Z",
							status: "pending",
						},
						{
							id: 102,
							type: "sol",
							delayedWithdrawalId: "sol-102",
							userPubkey: pubkey,
							recipient: pubkey,
							delayMinutes: 20,
							executeAt: "2026-02-10T02:00:00.000Z",
							status: "pending",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					message: "Delayed withdrawal cancelled",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					message: "Delayed withdrawal cancelled",
				}),
			);

		const result = await sdk.cancelAllTimedWithdrawals({ type: "sol" });

		expect(result).toEqual({
			success: true,
			totalPending: 2,
			requested: 2,
			canceled: 2,
			results: [
				{
					id: 101,
					type: "sol",
					success: true,
					message: "Delayed withdrawal cancelled",
				},
				{
					id: 102,
					type: "sol",
					success: true,
					message: "Delayed withdrawal cancelled",
				},
			],
		});
		expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
			1,
			`https://relayer.test/withdraw/delayed/user/${encodeURIComponent(pubkey)}`,
			undefined,
			3,
		);
	});
});
