import "dotenv/config";
import { CloakSDK, Connection, Keypair, PublicKey } from "./src";
import fs from "fs";

function loadKeypair(): Keypair {
	const secretKeyPath =
		process.env.KEYPAIR_PATH ||
		`${process.env.HOME}/.config/solana/id.json`;

	if (!fs.existsSync(secretKeyPath)) {
		throw new Error(
			`Keypair file not found at ${secretKeyPath}. Set KEYPAIR_PATH or create one with solana-keygen.`,
		);
	}

	const secretKey = JSON.parse(fs.readFileSync(secretKeyPath, "utf-8"));
	if (!Array.isArray(secretKey) || secretKey.length !== 64) {
		throw new Error(`Invalid keypair file format at ${secretKeyPath}.`);
	}

	return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
	const keypair = loadKeypair();
	const connection = new Connection(
		process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
		"confirmed",
	);
	const relayerUrl = process.env.RELAYER_URL || "https://cloak.axiom.trade";
	const altAddress =
		process.env.ALT_ADDRESS ||
		"G1Wc4i6fqiEY1UYn27y6E6RFCBSB1cQ256pAzwrmbiPj";

	const sdk = new CloakSDK({
		connection,
		relayerUrl,
		altAddress,
		verbose: true,
	});
	sdk.setSigner(keypair);
	await sdk.initialize();

	const recipient =
		process.env.RECIPIENT_ADDRESS || keypair.publicKey.toBase58();
	const delayMinutes = Number(process.env.TIMED_WITHDRAW_DELAY_MINUTES || "30");
	const requestedAmount = Number(process.env.TIMED_WITHDRAW_AMOUNT_SOL || "0.0001");

	if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
		throw new Error("TIMED_WITHDRAW_DELAY_MINUTES must be a positive number.");
	}
	if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
		throw new Error("TIMED_WITHDRAW_AMOUNT_SOL must be a positive number.");
	}
	new PublicKey(recipient); // Validate recipient format early.

	const max = await sdk.getMaxTransferableAmount({ numberOfWithdrawals: 1 });
	if (max.maxTransferableAmount <= 0) {
		throw new Error("No private SOL available to create a timed withdrawal.");
	}

	const amount = Math.min(requestedAmount, max.maxTransferableAmount);
	console.log(
		`[INFO] Creating timed withdrawal: amount=${amount} SOL, delay=${delayMinutes} min, recipient=${recipient}`,
	);

	const scheduled = await sdk.withdrawSol({
		recipientAddress: recipient,
		amount,
		delayMinutes,
		onStatus: (status) => console.log(`[INFO] ${status}`),
	});

	if (!scheduled.success || !scheduled.delayedWithdrawalId) {
		throw new Error(
			`Failed to create timed withdrawal: ${
				scheduled.error || "unknown error"
			}`,
		);
	}

	console.log(
		`[INFO] Timed withdrawal created. delayedWithdrawalId=${scheduled.delayedWithdrawalId} executeAt=${scheduled.executeAt}`,
	);

	const pending = await sdk.getAllTimedWithdrawals();
	const created = pending.find(
		(withdrawal) =>
			withdrawal.delayedWithdrawalId === scheduled.delayedWithdrawalId,
	);

	if (!created) {
		throw new Error(
			"Timed withdrawal was created but not found in getAllTimedWithdrawals().",
		);
	}

	console.log(
		`[INFO] Fetched timed withdrawal successfully. id=${created.id} type=${created.type} status=${created.status}`,
	);

	const cancelResult = await sdk.cancelTimedWithdrawal(created.id);
	if (!cancelResult.success) {
		throw new Error(
			`Failed to cancel timed withdrawal ${created.id}: ${
				cancelResult.error || "unknown error"
			}`,
		);
	}

	console.log(
		`[INFO] Timed withdrawal canceled. id=${created.id} message=${
			cancelResult.message || "ok"
		}`,
	);
}

main().catch((error) => {
	console.error("[ERROR]", error instanceof Error ? error.message : error);
	process.exit(1);
});

