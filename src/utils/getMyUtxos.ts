import { log, error as error } from "./logger";
import { Connection, PublicKey } from "@solana/web3.js";
import axios, { type AxiosResponse } from "axios";
import BN from "bn.js";
import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";
import { EncryptionService } from "./encryption";
import * as ffjavascript from "ffjavascript";
import { FETCH_UTXOS_GROUP_SIZE, PROGRAM_ID } from "./constants";
import { fetchWithRetry } from "./fetchWithRetry";
import type {
	StatusCallback,
	LightWasm,
	ApiUtxo,
	ApiUtxoResponse,
	DecryptionResult,
	FetchedUtxoBatch,
	UtxoCache,
} from "../types/internal";

// Batch size for parallel decryption
const DECRYPTION_BATCH_SIZE = 500; // Process 500 UTXOs in parallel
import type { Signed } from "./getAccountSign";

// Use type assertion for the utility functions (same pattern as in get_verification_keys.ts)
const utils = ffjavascript.utils as unknown as {
	unstringifyBigInts: (value: string) => unknown;
	leInt2Buff: (value: unknown, size: number) => Uint8Array;
};
const { unstringifyBigInts, leInt2Buff } = utils;

function sleep(ms: number): Promise<string> {
	return new Promise((resolve) =>
		setTimeout(() => {
			resolve("ok");
		}, ms),
	);
}

export function localstorageKey(key: PublicKey) {
	return (
		PROGRAM_ID.toString().substring(0, 6) +
		key.toString().substring(0, 6)
	);
}

/**
 * Global UTXO cache to avoid re-fetching encrypted outputs
 * NOTE: Encrypted outputs are the same for all wallets (public on-chain data)
 * Each wallet will decrypt only their own UTXOs from the shared encrypted outputs
 */
let utxoCache: UtxoCache | null = null;

/**
 * Clear the UTXO cache (call this when user changes or you want fresh data)
 */
export function clearUtxoCache() {
	utxoCache = null;
	spentStatusCache.clear();
}

/**
 * Force refresh - clears cache and fetches everything fresh
 */
export async function refreshUtxos(
	signed: Signed,
	connection: Connection,
	relayerUrl: string,
	setStatus?: StatusCallback,
	hasher?: LightWasm,
): Promise<Utxo[]> {
	clearUtxoCache();
	return getMyUtxos(
		signed,
		connection,
		relayerUrl,
		setStatus,
		hasher,
		true,
	);
}

const getMyUtxosPromises = new Map<string, Promise<FetchedUtxoBatch>>();

// Cache spent-status checks briefly to reduce repeated RPC pressure during retries.
const SPENT_STATUS_CACHE_TTL_MS = 30_000;
const spentStatusCache = new Map<
	string,
	{ spent: boolean; checkedAt: number }
>();

function getInFlightFetchKey(signed: Signed, relayerUrl: string): string {
	return `${relayerUrl}|${signed.publicKey.toBase58()}`;
}

/**
 * Decrypt cached encrypted outputs for a specific wallet
 */
async function decryptCachedOutputs(
	encryptedOutputs: string[],
	signed: Signed,
	connection: Connection,
	hasher: LightWasm,
): Promise<Utxo[]> {
	const lightWasm = hasher;

	// Initialize encryption service with this wallet's signature
	const encryptionService = new EncryptionService();
	encryptionService.deriveEncryptionKeyFromSignature(signed.signature);

	// Derive UTXO keypair for this wallet
	const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
	const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

	const candidateUtxos: Utxo[] = [];
	const seenEncryptedOutputs = new Set<string>();

	log(`[SDK] Decrypting ${encryptedOutputs.length} encrypted outputs...`);

	let decryptedCount = 0;
	let zeroAmountCount = 0;
	let duplicateCount = 0;

	// Decrypt all encrypted outputs in batches
	const BATCH_SIZE = 500;
	for (let i = 0; i < encryptedOutputs.length; i += BATCH_SIZE) {
		const batch = encryptedOutputs.slice(
			i,
			Math.min(i + BATCH_SIZE, encryptedOutputs.length),
		);

		const batchResults = await Promise.all(
			batch.map((encryptedOutput) =>
				decrypt_output(
					encryptedOutput,
					encryptionService,
					utxoKeypair,
					lightWasm,
					connection,
				),
			),
		);

		// Filter for successfully decrypted, non-zero UTXOs
		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j];
			const encryptedOutput = batch[j];
			const globalIndex = i + j;

			if (result.status === "decrypted" && result.utxo) {
				decryptedCount++;
				const utxo = result.utxo;
				utxo.index = globalIndex;

				// Skip zero-amount UTXOs
				if (utxo.amount.toNumber() === 0) {
					zeroAmountCount++;
					continue;
				}

				// Skip duplicates
				if (seenEncryptedOutputs.has(encryptedOutput)) {
					duplicateCount++;
					continue;
				}

				candidateUtxos.push(utxo);
				seenEncryptedOutputs.add(encryptedOutput);
			}
		}
	}

	log(
		`[SDK] Decryption results: ${decryptedCount} decrypted, ${zeroAmountCount} zero-amount, ${duplicateCount} duplicates, ${candidateUtxos.length} candidates`,
	);

	// Log candidate UTXOs with details
	candidateUtxos.forEach((utxo, i) => {
		log(
			`[SDK]   Candidate UTXO ${i + 1}: amount=${utxo.amount.toString()}, mintAddress=${utxo.mintAddress}, index=${utxo.index}`,
		);
	});

	if (candidateUtxos.length === 0) {
		return [];
	}

	// Batch check if UTXOs are spent (must be AFTER index update!)
	log(
		`[SDK DEBUG CACHE] About to check spent status for ${candidateUtxos.length} candidate UTXOs`,
	);
	const spentStatuses = await batchCheckUtxosSpent(
		connection,
		candidateUtxos,
	);
	const spentCount = spentStatuses.filter((s) => s).length;
	log(
		`[SDK DEBUG CACHE] Spent check complete: ${spentCount} spent, ${candidateUtxos.length - spentCount} unspent`,
	);

	// Filter out spent UTXOs and log which ones are kept
	const validUtxos: Utxo[] = [];
	const unspentIndices: number[] = [];
	candidateUtxos.forEach((utxo, index) => {
		if (!spentStatuses[index]) {
			validUtxos.push(utxo);
			unspentIndices.push(index);
		}
	});

	log(
		`[SDK] Final UTXOs: ${validUtxos.length} valid (${spentCount} were spent)`,
	);
	if (validUtxos.length > 0 && validUtxos.length < 20) {
		log(
			`[SDK DEBUG CACHE] Unspent UTXO indices in candidate list: ${unspentIndices.join(", ")}`,
		);
		validUtxos.slice(0, 5).forEach(async (utxo, i) => {
			const nullifier = await utxo.getNullifier();
			log(
				`[SDK DEBUG CACHE] Unspent UTXO ${i}: index=${utxo.index}, nullifier=${nullifier}`,
			);
		});
	}

	// Log final valid UTXOs
	validUtxos.forEach((utxo, i) => {
		log(
			`[SDK]   Valid UTXO ${i + 1}: amount=${utxo.amount.toString()}, mintAddress=${utxo.mintAddress}, index=${utxo.index}`,
		);
	});

	return validUtxos;
}

/**
 * Fetch and decrypt all UTXOs for a user (with caching)
 * @param signed The user's signature
 * @param connection Solana connection to fetch on-chain commitment accounts
 * @param setStatus A global state updator. Set live status message showing on webpage
 * @param hasher The hasher instance
 * @param forceRefresh Force a complete refresh ignoring cache
 * @returns Array of decrypted UTXOs that belong to the user
 */
export async function getMyUtxos(
	signed: Signed,
	connection: Connection,
	relayerUrl: string,
	setStatus?: StatusCallback,
	hasher?: LightWasm,
	forceRefresh: boolean = false,
): Promise<Utxo[]> {
	if (!signed) {
		throw new Error("signed undefined");
	}
	if (!hasher) {
		throw new Error("getMyUtxos:no hasher");
	}
	if (!relayerUrl) {
		throw new Error("getMyUtxos:no relayerUrl");
	}

	type RemoteTreeState = { root: string; nextIndex: number };
	let treeStatePromise: Promise<RemoteTreeState> | null = null;

	// Helper to query tree state
	async function queryRemoteTreeState(
		forceRefresh: boolean = false,
	): Promise<RemoteTreeState> {
		if (!forceRefresh && treeStatePromise) {
			return await treeStatePromise;
		}

		treeStatePromise = (async () => {
			const prepareUrl = `${relayerUrl}/tx/prepare`;
			const fallbackUrl = `${relayerUrl}/merkle/root`;
			let prepareStatus: number | null = null;
			try {
				const prepareResponse = await fetchWithRetry(
					prepareUrl,
					undefined,
					3,
				);
				prepareStatus = prepareResponse.status;
				if (prepareResponse.ok) {
					return (await prepareResponse.json()) as RemoteTreeState;
				}
			} catch {
				// Backwards compatibility fallback below.
			}

			const fallbackResponse = await fetchWithRetry(
				fallbackUrl,
				undefined,
				3,
			);
			if (!fallbackResponse.ok) {
				const body = await fallbackResponse.text().catch(() => "");
				throw new Error(
					`Relayer tree-state endpoint not found. Tried ${prepareUrl} (HTTP ${prepareStatus ?? "error"}) then ${fallbackUrl} (HTTP ${fallbackResponse.status}). Body: ${body.slice(0, 200)}`,
				);
			}
			return (await fallbackResponse.json()) as RemoteTreeState;
		})();

		return await treeStatePromise;
	}

	// Check if we have cached encrypted outputs
	log(
		`[SDK DEBUG] forceRefresh=${forceRefresh}, utxoCache=${utxoCache ? "exists" : "null"}, cacheLength=${utxoCache?.encryptedOutputs?.length || 0}`,
	);
	if (
		!forceRefresh &&
		utxoCache &&
		utxoCache.encryptedOutputs.length > 0
	) {
		log(
			`[SDK] Using cached data. Cache has ${utxoCache.encryptedOutputs.length} encrypted outputs, lastFetchedIndex: ${utxoCache.lastFetchedIndex}`,
		);

		// Check if there are new encrypted outputs to fetch
		const currentTreeState = await queryRemoteTreeState();
		const totalUtxosInTree = currentTreeState.nextIndex;

		log(
			`[SDK] Current tree state: ${totalUtxosInTree} total UTXOs`,
		);

		if (totalUtxosInTree > utxoCache.lastFetchedIndex) {
			// Fetch new encrypted outputs
			const newUtxoCount =
				totalUtxosInTree - utxoCache.lastFetchedIndex;
			log(
				`[SDK] Fetching ${newUtxoCount} new UTXOs (${utxoCache.lastFetchedIndex} -> ${totalUtxosInTree})`,
			);
			setStatus?.(`(loading ${newUtxoCount} new utxos...)`);

			const url = `${relayerUrl}/utxos/range?start=${utxoCache.lastFetchedIndex}&end=${totalUtxosInTree}`;
			const newBatch = await fetchUserUtxos(
				signed,
				connection,
				url,
				setStatus,
				hasher,
				utxoCache.lastFetchedIndex,
			);

			log(
				`[SDK] Fetched ${newBatch.encryptedOutputs.length} new encrypted outputs`,
			);

			// Add new encrypted outputs to cache
			utxoCache.encryptedOutputs.push(
				...newBatch.encryptedOutputs,
			);
			utxoCache.lastFetchedIndex = totalUtxosInTree;

			log(
				`[SDK] Cache now has ${utxoCache.encryptedOutputs.length} encrypted outputs`,
			);
		} else {
			log(`[SDK] No new UTXOs to fetch`);
		}

		// Decrypt all cached encrypted outputs with THIS wallet's signature
		setStatus?.(
			`(decrypting ${utxoCache.encryptedOutputs.length} utxos...)`,
		);

		log(
			`[SDK DEBUG CACHE] About to call decryptCachedOutputs with ${utxoCache.encryptedOutputs.length} encrypted outputs`,
		);

			// Decrypt with the provided wallet signature
			const decryptedUtxos = await decryptCachedOutputs(
				utxoCache.encryptedOutputs,
				signed,
				connection,
				hasher,
			);

		log(
			`[SDK DEBUG CACHE] decryptCachedOutputs returned ${decryptedUtxos.length} valid UTXOs`,
		);

		return decryptedUtxos;
	}

	// Always fetch fresh UTXOs - no caching
	log(
		`[SDK DEBUG] Taking FRESH FETCH path - will fetch all UTXOs from relayer`,
	);
	const loadUtxos = async (
		statusCallback?: StatusCallback,
	): Promise<FetchedUtxoBatch> => {
		statusCallback?.(`(loading utxos...)`);
		let valid_utxos: Utxo[] = [];
		let all_encrypted_outputs: string[] = [];
		const seenEncryptedOutputs = new Set<string>();

			// OPTIMIZATION: Fetch all batches in parallel first
			const treeState = await queryRemoteTreeState();
			const totalUtxos = treeState.nextIndex;
			const batchPromises: Promise<FetchedUtxoBatch>[] = [];

			for (
				let offset = 0;
				offset < totalUtxos;
				offset += FETCH_UTXOS_GROUP_SIZE
			) {
				const end = Math.min(
					offset + FETCH_UTXOS_GROUP_SIZE,
					totalUtxos,
				);
				const url = `${relayerUrl}/utxos/range?start=${offset}&end=${end}`;
				batchPromises.push(
					fetchUserUtxos(
						signed,
						connection,
						url,
						statusCallback,
						hasher,
						offset,
					),
				);
			}

			const allBatches = await Promise.all(batchPromises);

			// Collect all encrypted outputs from all batches
			for (const batch of allBatches) {
				all_encrypted_outputs.push(
					...batch.encryptedOutputs,
				);
			}

			log(
				`[SDK DEBUG] Fetched ${all_encrypted_outputs.length} encrypted outputs from relayer`,
			);

			// Log how many UTXOs were decrypted successfully
			let totalDecryptedUtxos = 0;
			for (const batch of allBatches) {
				totalDecryptedUtxos += batch.utxos.length;
			}
			log(
				`[SDK DEBUG] Successfully decrypted ${totalDecryptedUtxos} UTXOs out of ${all_encrypted_outputs.length} encrypted outputs`,
			);

			// Process all batches
			for (const fetched of allBatches) {
				// First filter out zero-amount UTXOs
				const nonZeroUtxos: Array<[number, Utxo]> = [];
				for (let [k, utxo] of fetched.utxos.entries()) {
					if (utxo.amount.toNumber() === 0) {
						continue;
					}
					nonZeroUtxos.push([k, utxo]);
				}

				// Batch check all UTXOs for spent status
				const spentStatuses =
						await batchCheckUtxosSpent(
							connection,
							nonZeroUtxos.map(
							([_, utxo]) => utxo,
						),
						{ bypassCache: forceRefresh },
					);

				log(
					`[SDK DEBUG] Checked ${nonZeroUtxos.length} UTXOs for spent status, ${spentStatuses.filter((s) => !s).length} are unspent`,
				);

				// Process results
				for (let i = 0; i < nonZeroUtxos.length; i++) {
					const [k, utxo] = nonZeroUtxos[i];
					const isSpent = spentStatuses[i];

					if (isSpent) {
						continue;
					}

					const encryptedOutput =
						fetched.encryptedOutputs[k];
					if (
						seenEncryptedOutputs.has(
							encryptedOutput,
						)
					) {
						continue;
					}
					valid_utxos.push(utxo);
					seenEncryptedOutputs.add(
						encryptedOutput,
					);
				}
				if (!fetched.hashMore) {
					break;
				}
				await sleep(100);
			}
		statusCallback?.(
			`Processing ${valid_utxos.length} transactions...`,
		);
		return {
			utxos: valid_utxos,
			encryptedOutputs: all_encrypted_outputs,
			hashMore: false,
		};
	};

	const inFlightKey = getInFlightFetchKey(signed, relayerUrl);

	// If there's already a promise running for this wallet+relayer, wait for it.
	// This prevents duplicate relayer scans while avoiding cross-wallet data races.
	const inFlightPromise = getMyUtxosPromises.get(inFlightKey);
	if (inFlightPromise) {
		const result = await inFlightPromise;
		return result.utxos;
	}

	// Create and store new promise
	const loadPromise = loadUtxos(setStatus);
	getMyUtxosPromises.set(inFlightKey, loadPromise);

	try {
		const result = await loadPromise;

		// Populate encrypted output cache after successful fetch
		const treeState = await queryRemoteTreeState();
		log(
			`[SDK] Populating cache with ${result.encryptedOutputs.length} encrypted outputs, tree nextIndex: ${treeState.nextIndex}`,
		);
		utxoCache = {
			encryptedOutputs: result.encryptedOutputs, // Store all encrypted outputs for future decryption with different wallets
			lastFetchedIndex: treeState.nextIndex,
		};

		log(
			`[SDK] Returning ${result.utxos.length} UTXOs from initial load`,
		);

		return result.utxos;
	} finally {
		// Clear the in-flight promise after completion so next call creates a new one.
		getMyUtxosPromises.delete(inFlightKey);
	}
}

/**
 * Fetch and decrypt UTXOs from apiUrl
 * @param signed The user's signature
 * @param connection Solana connection to fetch on-chain commitment accounts
 * @param apiUrl API URL to fetch UTXOs from
 * @returns Array of decrypted UTXOs that belong to the user
 */
async function fetchUserUtxos(
	signed: Signed,
	connection: Connection,
	apiUrl: string,
	setStatus?: StatusCallback,
	hasher?: LightWasm,
	startIndex: number = 0,
): Promise<{
	encryptedOutputs: string[];
	utxos: Utxo[];
	hashMore: boolean;
	len: number;
}> {
	try {
		if (!hasher) {
			throw new Error("fetchUserUtxos: no hasher");
		}
		// Initialize the light protocol hasher
		// const lightWasm = await getHasher()
		const lightWasm = hasher;

		// Initialize the encryption service and generate encryption key from the keypair
		const encryptionService = new EncryptionService();
		encryptionService.deriveEncryptionKeyFromSignature(
			signed.signature,
		);

		// Derive the UTXO keypair from the wallet keypair
		const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
		const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

		const url = apiUrl;

		// Fetch all UTXOs from the API
		let encryptedOutputs: string[] = [];
		let response: AxiosResponse<unknown>;
		let hasMore = false;
		let responseTotal = 0;
		try {
			response = await axios.get(url);

			if (!response.data) {
				error("API returned empty data");
			} else if (Array.isArray(response.data)) {
				// Handle the case where the API returns an array of UTXOs
				const utxos: ApiUtxo[] = response.data;

				// Extract encrypted outputs from the array of UTXOs
				encryptedOutputs = utxos
					.filter((utxo) => utxo.encrypted_output)
					.map((utxo) => utxo.encrypted_output);
			} else if (
				typeof response.data === "object" &&
				response.data !== null &&
				"encrypted_outputs" in response.data
			) {
				// Handle the case where the API returns an object with encrypted_outputs array
				const apiResponse =
					response.data as ApiUtxoResponse;
				encryptedOutputs =
					apiResponse.encrypted_outputs;
				hasMore = Boolean(apiResponse.hasMore);
				if (typeof apiResponse.total === "number") {
					responseTotal = apiResponse.total;
				}
			} else {
				error(
					`API returned unexpected data format: ${JSON.stringify(
						response.data,
					).substring(0, 100)}...`,
				);
			}
		} catch (apiError: unknown) {
			throw new Error(
				`API request failed: ${
					apiError instanceof Error
						? apiError.message
						: String(apiError)
				}`,
			);
		}

		// Try to decrypt each encrypted output
		const myUtxos: Utxo[] = [];
		const myEncryptedOutputs: string[] = [];

		const decryptionTaskTotal = Math.max(
			encryptedOutputs.length,
			responseTotal,
		);

		// Process encrypted outputs in parallel batches - only fresh from API
		for (
			let i = 0;
			i < encryptedOutputs.length;
			i += DECRYPTION_BATCH_SIZE
		) {
			const batch = encryptedOutputs.slice(
				i,
				Math.min(
					i + DECRYPTION_BATCH_SIZE,
					encryptedOutputs.length,
				),
			);
			setStatus?.(
				`(decrypting utxos: ${
					i + 1
				}-${Math.min(
					i + batch.length,
					decryptionTaskTotal,
				)}/${decryptionTaskTotal}...)`,
			);

			// Decrypt batch in parallel
			const batchResults = await Promise.all(
				batch.map((encryptedOutput: string) =>
					decrypt_output(
						encryptedOutput,
						encryptionService,
						utxoKeypair,
						lightWasm,
						connection,
					),
				),
			);

			// Process results
			batchResults.forEach((dres, index) => {
				if (dres.status == "decrypted" && dres.utxo) {
					dres.utxo.index =
						startIndex + i + index;
					myUtxos.push(dres.utxo);
					myEncryptedOutputs.push(batch[index]);
				}
			});
		}

		return {
			encryptedOutputs: encryptedOutputs, // Return ALL encrypted outputs, not just the ones we decrypted
			utxos: myUtxos,
			hashMore: hasMore,
			len: encryptedOutputs.length,
		};
	} catch (err: unknown) {
		error(
			"Error fetching UTXOs:",
			err instanceof Error ? err.message : String(err),
		);
		return {
			encryptedOutputs: [],
			utxos: [],
			hashMore: false,
			len: 0,
		};
	}
}

/**
 * Batch check if multiple UTXOs have been spent
 * @param connection Solana connection
 * @param utxos Array of UTXOs to check
 * @returns Promise<boolean[]> Array of spent status (true if spent, false if unspent) in same order as input
 */
async function batchCheckUtxosSpent(
	connection: Connection,
	utxos: Utxo[],
	options?: { bypassCache?: boolean },
): Promise<boolean[]> {
	if (utxos.length === 0) return [];

	try {
		// Generate nullifier metadata for all UTXOs.
		const now = Date.now();
		const nullifierHexes: string[] = [];
		const spentStatuses: boolean[] = new Array(utxos.length).fill(
			false,
		);
		const uncachedIndices: number[] = [];
		const bypassCache = options?.bypassCache === true;

		for (let i = 0; i < utxos.length; i++) {
			const utxo = utxos[i];
			const nullifier = await utxo.getNullifier();
			const nullifierBytes = Array.from(
				leInt2Buff(unstringifyBigInts(nullifier), 32),
			).reverse() as number[];
			const nullifierHex =
				Buffer.from(nullifierBytes).toString("hex");
			nullifierHexes.push(nullifierHex);

			if (bypassCache) {
				uncachedIndices.push(i);
				continue;
			}

			const cached = spentStatusCache.get(nullifierHex);
			if (
				cached &&
				now - cached.checkedAt <
					SPENT_STATUS_CACHE_TTL_MS
			) {
				spentStatuses[i] = cached.spent;
			} else {
				uncachedIndices.push(i);
			}
		}

		// Everything was served from cache.
		if (uncachedIndices.length === 0) {
			return spentStatuses;
		}

		// Generate PDAs only for uncached UTXOs.
		const allPDAs: PublicKey[] = [];
		const utxoPDAMap = new Map<
			number,
			{ nullifier0Index: number; nullifier1Index: number }
		>();

		for (const i of uncachedIndices) {
			const nullifierBuffer = Buffer.from(
				nullifierHexes[i],
				"hex",
			);

			const [nullifier0PDA] =
				PublicKey.findProgramAddressSync(
					[
						Buffer.from("nullifier0"),
						nullifierBuffer,
					],
					PROGRAM_ID,
				);

			const [nullifier1PDA] =
				PublicKey.findProgramAddressSync(
					[
						Buffer.from("nullifier1"),
						nullifierBuffer,
					],
					PROGRAM_ID,
				);

			const nullifier0Index = allPDAs.length;
			allPDAs.push(nullifier0PDA);
			const nullifier1Index = allPDAs.length;
			allPDAs.push(nullifier1PDA);

			utxoPDAMap.set(i, { nullifier0Index, nullifier1Index });
		}

		// Fetch all accounts in batches with retry/backoff to reduce rate-limit failures.
		const BATCH_SIZE = 50;
		const MAX_RETRIES = 4;
		const BASE_DELAY_MS = 300;
		const allAccountInfos: (
			| import("@solana/web3.js").AccountInfo<Buffer>
			| null
		)[] = [];

		for (let i = 0; i < allPDAs.length; i += BATCH_SIZE) {
			const batch = allPDAs.slice(
				i,
				Math.min(i + BATCH_SIZE, allPDAs.length),
			);
				let batchResults:
					| (
							| import("@solana/web3.js").AccountInfo<Buffer>
							| null
					  )[]
					| null = null;
				let lastErr: unknown = null;

			for (
				let attempt = 0;
				attempt <= MAX_RETRIES;
				attempt++
			) {
				try {
					batchResults =
						await connection.getMultipleAccountsInfo(
							batch,
						);
					break;
				} catch (err: unknown) {
						lastErr = err;
						const msg = String(
							err instanceof Error
								? err.message
								: err,
						).toLowerCase();
					const isRateLimit =
						msg.includes("429") ||
						msg.includes(
							"too many requests",
						);
					if (
						!isRateLimit ||
						attempt === MAX_RETRIES
					) {
						throw err;
					}

					const delayMs =
						BASE_DELAY_MS *
						Math.pow(2, attempt);
					await new Promise((resolve) =>
						setTimeout(resolve, delayMs),
					);
				}
			}
			if (!batchResults) {
				throw (
					lastErr ||
					new Error(
						"Failed to fetch batch account infos",
					)
				);
			}
			allAccountInfos.push(...batchResults);
		}

		// Check which uncached UTXOs are spent based on account existence, then cache.
		let debugCount = 0;
		for (const i of uncachedIndices) {
			const pda = utxoPDAMap.get(i)!;
			const nullifier0Info =
				allAccountInfos[pda.nullifier0Index];
			const nullifier1Info =
				allAccountInfos[pda.nullifier1Index];
			const isSpent = !!(nullifier0Info || nullifier1Info);
			spentStatuses[i] = isSpent;
			spentStatusCache.set(nullifierHexes[i], {
				spent: isSpent,
				checkedAt: now,
			});

			// Debug first 3 UTXOs
			if (debugCount < 3) {
				log(
					`[SDK DEBUG NULLIFIER] UTXO ${i}: nullifier0=${nullifier0Info ? "EXISTS" : "null"}, nullifier1=${nullifier1Info ? "EXISTS" : "null"}, isSpent=${isSpent}`,
				);
				debugCount++;
			}
		}

		return spentStatuses;
		} catch (err: unknown) {
			error("Error in batch checking UTXOs:", err);
			// Fail closed: if spent-check fails, treat as spent to prevent nullifier collisions/double-spend attempts.
			return new Array(utxos.length).fill(true);
	}
}

/**
 * Check if a UTXO has been spent using the relayer API
 * @param connection Solana connection (kept for compatibility but not used)
 * @param utxo The UTXO to check
 * @returns Promise<boolean> true if spent, false if unspent
 */
export async function isUtxoSpent(
	connection: Connection,
	utxo: Utxo,
	relayerUrl?: string,
): Promise<boolean> {
	try {
		// Get the nullifier for this UTXO
		const nullifier = await utxo.getNullifier();

		// Convert decimal nullifier string to hex format for the API
		const nullifierBytes = Array.from(
			leInt2Buff(unstringifyBigInts(nullifier), 32),
		).reverse() as number[];
		const nullifierHex =
			Buffer.from(nullifierBytes).toString("hex");

		// First check on-chain to see if nullifier account exists
		// This is the source of truth, relayer might be behind
		try {
			// Find nullifier PDA - check both nullifier0 and nullifier1
			const nullifierBuffer = Buffer.from(nullifierBytes);

			const [nullifier0PDA] =
				PublicKey.findProgramAddressSync(
					[
						Buffer.from("nullifier0"),
						nullifierBuffer,
					],
					PROGRAM_ID,
				);

			const [nullifier1PDA] =
				PublicKey.findProgramAddressSync(
					[
						Buffer.from("nullifier1"),
						nullifierBuffer,
					],
					PROGRAM_ID,
				);

			log(`  nullifier0PDA: ${nullifier0PDA.toString()}`);
			log(`  nullifier1PDA: ${nullifier1PDA.toString()}`);
			log(`  UTXO index: ${utxo.index}`);
			log(`  UTXO amount: ${utxo.amount.toString()}`);

			// Check if either nullifier account exists on-chain
			const [nullifier0Info, nullifier1Info] =
				await Promise.all([
					connection.getAccountInfo(
						nullifier0PDA,
					),
					connection.getAccountInfo(
						nullifier1PDA,
					),
				]);

			if (nullifier0Info || nullifier1Info) {
				return true;
			}

			return false;
			} catch (onChainError: unknown) {
				log(
					`On-chain check failed, falling back to relayer: ${
						onChainError instanceof Error
							? onChainError.message
							: String(onChainError)
					}`,
				);

			// Fallback to relayer API if on-chain check fails
			const response = await axios.post(
				`${relayerUrl}/nullifiers/check`,
				{
					nullifiers: [nullifierHex],
				},
			);

			if (response.data && response.data.nullifiers) {
				const isSpent =
					response.data.nullifiers[
						nullifierHex
					] === true;
				return isSpent;
			}

			// If response format is unexpected, assume unspent
			return false;
		}
		} catch (err: unknown) {
			error("Error checking if UTXO is spent:", err);
			const errMessage =
				err instanceof Error ? err.message : String(err);
			if (errMessage.includes("429")) {
				error("code 429, retry..");
				await new Promise((resolve) =>
					setTimeout(resolve, 5000),
				);
				return await isUtxoSpent(connection, utxo, relayerUrl);
			}
		// Default to unspent on error (was 'spent' before, but unspent is safer)
		return false;
	}
}

// Calculate and display total balance
export function getBalanceFromUtxos(utxos: Utxo[]): number {
	const totalBalance = utxos.reduce(
		(sum, utxo) => sum.add(utxo.amount),
		new BN(0),
	);
	const LAMPORTS_PER_SOL = new BN(1000000000); // 1 billion lamports = 1 SOL
	const balanceInSol = totalBalance.div(LAMPORTS_PER_SOL);
	const remainderLamports = totalBalance.mod(LAMPORTS_PER_SOL);
	const balanceInSolWithDecimals =
		balanceInSol.toNumber() +
		remainderLamports.toNumber() / 1000000000;
	return balanceInSolWithDecimals;
}

// Decrypt single output to Utxo
async function decrypt_output(
	encryptedOutput: string,
	encryptionService: EncryptionService,
	utxoKeypair: UtxoKeypair,
	lightWasm: LightWasm,
	_connection: Connection,
): Promise<DecryptionResult> {
	let res: DecryptionResult = { status: "unDecrypted" };
	try {
		if (!encryptedOutput) {
			return { status: "skipped" };
		}

		// Try to decrypt the UTXO
		res.utxo = encryptionService.decryptUtxo(
			encryptedOutput,
			utxoKeypair,
			lightWasm,
		);

		// If we got here, decryption succeeded, so this UTXO belongs to the user
		res.status = "decrypted";
		} catch (_error: unknown) {
			// Silently skip - this UTXO doesn't belong to the user
			// (Failed decryption is expected for UTXOs belonging to other users)
		}
	return res;
}
