import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import path from "path";

export const FIELD_SIZE = new BN(
	"21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export const PROGRAM_ID = new PublicKey(
	process.env.CLOAK_PROGRAM_ID ||
		"8wbkRNdUfjsL3hJotuHX9innLPAdChJ5qGYG41Htpmuk",
);

export const DEPLOYER_ID = new PublicKey(
	process.env.CLOAK_DEPLOYER_ID ||
		"HEosZaCHerU9Lyt9TkQ8FWyP8qYPvWc9N8gjsroLUmGK",
);

export const FEE_RECIPIENT = new PublicKey(
	process.env.CLOAK_FEE_RECIPIENT ||
		"HEosZaCHerU9Lyt9TkQ8FWyP8qYPvWc9N8gjsroLUmGK",
);

export const FETCH_UTXOS_GROUP_SIZE = 1000; // Fetch 1000 UTXOs per batch for faster loading

export const TRANSACT_IX_DISCRIMINATOR = Buffer.from([
	217, 149, 130, 143, 221, 52, 252, 119,
]);

export const TRANSACT_SPL_IX_DISCRIMINATOR = Buffer.from([
	154, 66, 244, 204, 78, 225, 163, 151,
]);
// For SDK, circuits are in the circuits/ directory relative to the package root
// In Node.js, we need to use an absolute path or path relative to process.cwd()
// In the browser, this should be a web path (e.g., /circuits/circuit2)
export const CIRCUIT_PATH =
	process.env.CIRCUIT_PATH ||
	(typeof globalThis !== 'undefined' && typeof (globalThis as any).window !== 'undefined'
		? '/circuits/circuit2'  // Browser: use web path
		: path.join(__dirname, "../../circuits/circuit2")); // Node.js: use file path

export const MERKLE_TREE_DEPTH = 26;

export const DEPOSIT_FEE_RATE = 0.3; // 0% - deposits are free

export const WITHDRAW_FEE_RATE = 0.3; // 0.25%

// export const REFERRAL_DISCOUNT = 0.005; // 0.5% discount

// mainnet = 9AEDwPFezwNNjgbm7jKnYVp6iWZmaXSXmvZ94NqgCyZX
// devnet = Dy1kWrcceThLo9ywoMH2MpWTsBe9pxsv3fCcTj3sSDK9
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
export const ALT_ADDRESS = new PublicKey(
	SOLANA_CLUSTER !== "devnet"
		? "9AEDwPFezwNNjgbm7jKnYVp6iWZmaXSXmvZ94NqgCyZX"
		: "Dy1kWrcceThLo9ywoMH2MpWTsBe9pxsv3fCcTj3sSDK9",
);

export const relayer_API_URL =
	process.env.relayer_API_URL || "https://dev-api.cloaklabs.dev";

// ===== SPL Token Support =====

export interface SupportedToken {
	name: string;
	symbol: string;
	mintAddress: string;
	decimals: number;
	logoUri?: string;
}

// Native SOL (represented as System Program for compatibility)
export const NATIVE_SOL: SupportedToken = {
	name: "Solana",
	symbol: "SOL",
	mintAddress: "11111111111111111111111111111112",
	decimals: 9,
	logoUri: "/tokens/sol.svg",
};

// Mainnet SPL Tokens
export const SUPPORTED_TOKENS_MAINNET: SupportedToken[] = [
	NATIVE_SOL,
	{
		name: "USD Coin",
		symbol: "USDC",
		mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		decimals: 6,
		logoUri: "/tokens/usdc.png",
	},
	{
		name: "Helius Staked SOL",
		symbol: "hSOL",
		mintAddress: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
		decimals: 9,
		logoUri: "/tokens/hSOL.png",
	},
];

// Devnet SPL Tokens (for testing)
export const SUPPORTED_TOKENS_DEVNET: SupportedToken[] = [
	NATIVE_SOL,
	{
		name: "Devnet USDC",
		symbol: "USDC",
		mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Devnet USDC
		decimals: 6,
	},
	{
		name: "Helius Staked SOL",
		symbol: "hSOL",
		mintAddress: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
		decimals: 9,
		logoUri: "/tokens/hSOL.png",
	},
];

// Default to mainnet tokens (can be changed based on environment)
export const SUPPORTED_TOKENS = SUPPORTED_TOKENS_MAINNET;

// Helper function to get token by mint address
export function getTokenByMint(
	mintAddress: string,
): SupportedToken | undefined {
	return SUPPORTED_TOKENS.find(
		(token) => token.mintAddress === mintAddress,
	);
}

// Helper function to check if token is supported
export function isTokenSupported(mintAddress: string): boolean {
	return SUPPORTED_TOKENS.some(
		(token) => token.mintAddress === mintAddress,
	);
}
