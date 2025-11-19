/**
 * Simple example for testing SOL and USDC deposit/withdraw
 */

import "dotenv/config";
import {
	CloakSDK,
	Connection,
	generateUtxoWalletSignature,
	Keypair,
	isCloakError,
	ErrorCodes,
} from "./src";
import fs from "fs";

async function main() {
	console.log("[INFO] Starting SOL & USDC deposit/withdraw test\n");

	// Load keypair with error handling
	let keypair: Keypair;
	try {
		const secretKeyPath =
			process.env.KEYPAIR_PATH ||
			process.env.HOME + "/.config/solana/id.json";

		console.log(`[INFO] Loading keypair from: ${secretKeyPath}`);

		if (!fs.existsSync(secretKeyPath)) {
			throw new Error(
				`Keypair file not found at ${secretKeyPath}. ` +
					`Please generate a keypair with: solana-keygen new --outfile ${secretKeyPath}`,
			);
		}

		const secretKey = JSON.parse(
			fs.readFileSync(secretKeyPath, "utf-8"),
		);

		if (!Array.isArray(secretKey) || secretKey.length !== 64) {
			throw new Error(
				`Invalid keypair format in ${secretKeyPath}. ` +
					`Expected an array of 64 numbers.`,
			);
		}

		keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
		console.log(
			`[INFO] Keypair loaded successfully: ${keypair.publicKey.toString()}\n`,
		);
	} catch (err: any) {
		console.error("[ERROR] Failed to load keypair:", err.message);
		console.error("\nTo generate a new keypair, run:");
		console.error(
			"  solana-keygen new --outfile ~/.config/solana/id.json",
		);
		console.error(
			"\nOr set KEYPAIR_PATH environment variable to your keypair file.",
		);
		process.exit(1);
	}

	// Setup connection
	const connection = new Connection(
		process.env.RPC_URL ||
			"https://devnet.helius-rpc.com/?api-key=",
		"confirmed",
	);

	// Initialize SDK
	const sdk = new CloakSDK({
		connection,
		signer: new Keypair(),
		verbose: false, // ENABLE VERBOSE LOGGING TO DEBUG
		relayerUrl:
			process.env.RELAYER_API_URL ||
			"https://dev-api.cloaklabs.dev",
	});

	console.log("[INFO] Initializing SDK...");
	await sdk.initialize();
	let signature = await generateUtxoWalletSignature(keypair);
	console.log("[INFO] SDK initialized successfully\n");

	// ============================================
	// SOL TESTS
	// ============================================
	console.log("[INFO] Starting SOL transfer test\n");

	// Check initial SOL balance (force refresh to get fresh data)
	console.log("[INFO] Checking initial SOL balance...");
	const initialSolBalance = await sdk.getSolBalance(signature, true); // Force refresh
	console.log(
		`[INFO] Initial SOL balance: ${
			initialSolBalance.total.toNumber() / 1e9
		} SOL (${initialSolBalance.count} UTXOs)\n`,
	);

	// Deposit SOL
	const solDepositAmount = 0.01; // 0.01 SOL
	console.log(
		`[INFO] Depositing ${solDepositAmount} SOL into privacy pool...`,
	);

	try {
		const solDepositResult = await sdk.depositSol({
			amount: solDepositAmount,
			onStatus: (status: string) =>
				console.log(`[INFO] ${status}`),
			utxoWalletSigned: signature,
			utxoWalletSignTransaction: async (tx) => {
				// Sign the transaction with the actual funded keypair
				(tx as any).sign([keypair]);
				return tx;
			},
		});

		if (!solDepositResult.success) {
			console.error(
				"[ERROR] SOL deposit failed:",
				solDepositResult.error,
			);
			if (isCloakError(solDepositResult.error)) {
				console.error(
					`[ERROR] Error code: ${solDepositResult.error.code}`,
				);
				if (solDepositResult.error.details) {
					console.error(
						"[ERROR] Details:",
						JSON.stringify(
							solDepositResult.error
								.details,
							null,
							2,
						),
					);
				}
			}
			process.exit(1);
		}

		console.log("[INFO] SOL deposit successful");
		console.log(
			`[INFO] Transaction signature: ${solDepositResult.signature}`,
		);
		console.log(
			`[INFO] View on explorer: https://explorer.solana.com/tx/${solDepositResult.signature}?cluster=devnet\n`,
		);
	} catch (error) {
		console.error("[ERROR] SOL deposit failed with exception");
		if (isCloakError(error)) {
			console.error(`[ERROR] Error code: ${error.code}`);
			console.error(`[ERROR] Message: ${error.message}`);
			if (error.details) {
				console.error(
					"[ERROR] Details:",
					JSON.stringify(error.details, null, 2),
				);
			}
		} else {
			console.error("[ERROR]", error);
		}
		process.exit(1);
	}

	// Check balance after deposit
	const postSolDepositBalance = await sdk.getSolBalance(signature);
	console.log(
		`[INFO] SOL balance after deposit: ${
			postSolDepositBalance.total.toNumber() / 1e9
		} SOL (${postSolDepositBalance.count} UTXOs)\n`,
	);

	// Withdraw SOL
	const solWithdrawAmount = 0.005; // 0.005 SOL
	console.log(`[INFO] Withdrawing ${solWithdrawAmount} SOL...`);

	try {
		const solWithdrawResult = await sdk.withdrawSol({
			amount: solWithdrawAmount,
			recipientAddress: sdk.getPublicKey(), // Withdraw to self
			onStatus: (status: string) =>
				console.log(`[INFO] ${status}`),
			utxoWalletSigned: signature,
			maxRetries: 5,
		});

		if (!solWithdrawResult.success) {
			console.error(
				"[ERROR] SOL withdrawal failed:",
				solWithdrawResult.error,
			);
			if (isCloakError(solWithdrawResult.error)) {
				console.error(
					`[ERROR] Error code: ${solWithdrawResult.error.code}`,
				);
				if (solWithdrawResult.error.details) {
					console.error(
						"[ERROR] Details:",
						JSON.stringify(
							solWithdrawResult.error
								.details,
							null,
							2,
						),
					);
				}
			}
			process.exit(1);
		}

		console.log("[INFO] SOL withdrawal successful");
		console.log(
			`[INFO] Transaction signature: ${solWithdrawResult.signature}`,
		);
		console.log(
			`[INFO] View on explorer: https://explorer.solana.com/tx/${solWithdrawResult.signature}?cluster=devnet\n`,
		);
	} catch (error) {
		console.error("[ERROR] SOL withdrawal failed with exception");
		if (isCloakError(error)) {
			console.error(`[ERROR] Error code: ${error.code}`);
			console.error(`[ERROR] Message: ${error.message}`);
			if (error.details) {
				console.error(
					"[ERROR] Details:",
					JSON.stringify(error.details, null, 2),
				);
			}
		} else {
			console.error("[ERROR]", error);
		}
		process.exit(1);
	}

	// Final SOL balance
	const finalSolBalance = await sdk.getSolBalance(signature);
	console.log(
		`[INFO] Final SOL balance: ${
			finalSolBalance.total.toNumber() / 1e9
		} SOL (${finalSolBalance.count} UTXOs)\n`,
	);

	console.log("[INFO] SOL transfer test complete\n");

	// ============================================
	// USDC TESTS
	// ============================================
	console.log("[INFO] Starting USDC transfer test\n");

	// USDC mint address (devnet)
	// Note: Replace with the actual USDC mint address for your environment
	const USDC_MINT =
		process.env.USDC_MINT ||
		"Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"; // Devnet USDC

	// Check initial USDC balance (force refresh to get fresh data)
	console.log("[INFO] Checking initial USDC balance...");
	const initialBalance = await sdk.getSplBalance(
		USDC_MINT,
		signature,
		true,
	); // Force refresh
	console.log(
		`[INFO] Initial USDC balance: ${
			initialBalance.total.toNumber() / 1e6
		} USDC (${initialBalance.count} UTXOs)\n`,
	);

	// ============================================
	// DEPOSIT USDC
	// ============================================
	const depositAmount = 1_000_000; // 1 USDC (6 decimals)
	console.log(
		`[INFO] Depositing ${
			depositAmount / 1e6
		} USDC into privacy pool...`,
	);

	try {
		const depositResult = await sdk.depositSpl({
			amount: depositAmount,
			mintAddress: USDC_MINT,
			onStatus: (status) => console.log(`[INFO] ${status}`),
			utxoWalletSigned: signature,
			utxoWalletSignTransaction: async (tx) => {
				// Sign the transaction with the actual funded keypair
				(tx as any).sign([keypair]);
				return tx;
			},
			maxRetries: 5,
		});

		if (!depositResult.success) {
			console.error(
				"[ERROR] USDC deposit failed:",
				depositResult.error,
			);
			if (isCloakError(depositResult.error)) {
				console.error(
					`[ERROR] Error code: ${depositResult.error.code}`,
				);
				if (depositResult.error.details) {
					console.error(
						"[ERROR] Details:",
						JSON.stringify(
							depositResult.error
								.details,
							null,
							2,
						),
					);
				}
			}
			process.exit(1);
		}

		console.log("[INFO] USDC deposit successful");
		console.log(
			`[INFO] Transaction signature: ${depositResult.signature}`,
		);
		console.log(
			`[INFO] View on explorer: https://explorer.solana.com/tx/${depositResult.signature}?cluster=devnet\n`,
		);
	} catch (error) {
		console.error("[ERROR] USDC deposit failed with exception");
		if (isCloakError(error)) {
			console.error(`[ERROR] Error code: ${error.code}`);
			console.error(`[ERROR] Message: ${error.message}`);
			if (error.details) {
				console.error(
					"[ERROR] Details:",
					JSON.stringify(error.details, null, 2),
				);
			}
		} else {
			console.error("[ERROR]", error);
		}
		process.exit(1);
	}

	// Check balance after deposit
	const postDepositBalance = await sdk.getSplBalance(
		USDC_MINT,
		signature,
	);
	console.log(
		`[INFO] USDC balance after deposit: ${
			postDepositBalance.total.toNumber() / 1e6
		} USDC (${postDepositBalance.count} UTXOs)\n`,
	);

	// ============================================
	// WITHDRAW USDC
	// ============================================
	const withdrawAmount = 500_000; // 0.5 USDC (6 decimals)
	console.log(`[INFO] Withdrawing ${withdrawAmount / 1e6} USDC...`);

	try {
		const withdrawResult = await sdk.withdrawSpl({
			amount: withdrawAmount,
			mintAddress: USDC_MINT,
			recipientAddress: sdk.getPublicKey(), // Withdraw to self
			onStatus: (status) => console.log(`[INFO] ${status}`),
			utxoWalletSigned: signature,
			maxRetries: 5,
		});

		if (!withdrawResult.success) {
			console.error(
				"[ERROR] USDC withdrawal failed:",
				withdrawResult.error,
			);
			if (isCloakError(withdrawResult.error)) {
				console.error(
					`[ERROR] Error code: ${withdrawResult.error.code}`,
				);
				if (withdrawResult.error.details) {
					console.error(
						"[ERROR] Details:",
						JSON.stringify(
							withdrawResult.error
								.details,
							null,
							2,
						),
					);
				}
			}
			process.exit(1);
		}

		console.log("[INFO] USDC withdrawal successful");
		console.log(
			`[INFO] Transaction signature: ${withdrawResult.signature}`,
		);
		console.log(
			`[INFO] View on explorer: https://explorer.solana.com/tx/${withdrawResult.signature}?cluster=devnet\n`,
		);
	} catch (error) {
		console.error("[ERROR] USDC withdrawal failed with exception");
		if (isCloakError(error)) {
			console.error(`[ERROR] Error code: ${error.code}`);
			console.error(`[ERROR] Message: ${error.message}`);
			if (error.details) {
				console.error(
					"[ERROR] Details:",
					JSON.stringify(error.details, null, 2),
				);
			}
		} else {
			console.error("[ERROR]", error);
		}
		process.exit(1);
	}

	// ============================================
	// FINAL USDC BALANCE
	// ============================================
	const finalBalance = await sdk.getSplBalance(USDC_MINT, signature);
	console.log(
		`[INFO] Final USDC balance: ${
			finalBalance.total.toNumber() / 1e6
		} USDC (${finalBalance.count} UTXOs)\n`,
	);

	console.log("[INFO] USDC transfer test complete\n");

	console.log("[INFO] All tests completed successfully");

	process.exit(0);
}

main().catch((error) => {
	console.error("[ERROR] Unexpected error in main:");
	if (isCloakError(error)) {
		console.error(`[ERROR] Error code: ${error.code}`);
		console.error(`[ERROR] Message: ${error.message}`);
		if (error.details) {
			console.error(
				"[ERROR] Details:",
				JSON.stringify(error.details, null, 2),
			);
		}
	} else {
		console.error("[ERROR]", error);
	}
	process.exit(1);
});
