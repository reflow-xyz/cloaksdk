import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { Buffer } from "buffer";
import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";
import {
	parseProofToBytesArray,
	parseToBytesArray,
	prove,
} from "../utils/prover";
import { log, warn, error as error, serializeError } from "./logger";
import {
	CIRCUIT_PATH,
	FEE_RECIPIENT,
	FIELD_SIZE,
	MERKLE_TREE_DEPTH,
	PROGRAM_ID,
	TRANSACT_SPL_IX_DISCRIMINATOR,
} from "./constants";
import {
	EncryptionService,
	serializeProofAndExtData,
	uint8ArrayToBase64,
} from "./encryption";
import type { Signed } from "./getAccountSign";
import type { LightWasm, StatusCallback } from "../types/internal";
import { getExtDataHash } from "./getExtDataHash";
import { getMyUtxos, isUtxoSpent } from "./getMyUtxos";
import { WITHDRAW_FEE_RATE } from "./constants";
import {
	deriveTokenAccounts,
	getRelayerPublicKey,
	getGlobalConfigPDA,
} from "./spl-token-utils";
import { parseTransactionError } from "./validation";
import {
	ErrorCodes,
	ValidationError,
	NetworkError,
	TransactionError,
} from "../errors";
import { fetchWithRetry } from "./fetchWithRetry";
import { getSplMintId, mintIdMatches } from "./spl-mint-id";
import { requireHasher } from "./hasher-guard";
import { deriveNullifierPairPdas } from "./nullifier-pdas";
import { postRelayerJson } from "./relayer-client";
import { isUserRejectedError } from "./wallet-errors";

/**
 * Query remote tree state from relayer API
 */
async function queryRemoteTreeState(relayerUrl: string): Promise<{
	root: string;
	nextIndex: number;
}> {
	try {
		const response = await fetchWithRetry(
			`${relayerUrl}/merkle/root`,
			undefined,
			3,
		);
		if (!response.ok) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				`Failed to fetch Merkle root and nextIndex: ${response.status} ${response.statusText}`,
				{
					endpoint: `${relayerUrl}/merkle/root`,
					statusCode: response.status,
				},
			);
		}
		const data = (await response.json()) as {
			root: string;
			nextIndex: number;
		};
		log(`Fetched root from API: ${data.root}`);
		log(`Fetched nextIndex from API: ${data.nextIndex}`);
		return data;
	} catch (err) {
		error("Failed to fetch root and nextIndex from API:", err);
		throw err;
	}
}

/**
 * Fetch Merkle proof from API for a given commitment
 */
async function fetchMerkleProof(
	commitment: string,
	relayerUrl: string,
): Promise<{
	pathElements: string[];
	pathIndices: number[];
	index: number;
	root: string;
	nextIndex: number;
}> {
	try {
		const response = await fetchWithRetry(
			`${relayerUrl}/merkle/proof/${commitment}`,
			undefined,
			3,
		);
		if (!response.ok) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				`Failed to fetch Merkle proof: ${response.status} ${response.statusText}`,
				{
					endpoint: `${relayerUrl}/merkle/proof/${commitment}`,
					statusCode: response.status,
				},
			);
		}
		const data = (await response.json()) as {
			pathElements: string[];
			pathIndices: number[];
			index: number;
			root: string;
			nextIndex: number;
		};
		log(
			` Fetched Merkle proof with ${data.pathElements.length} elements for index ${data.index}`,
		);
		return data;
	} catch (err) {
		error(
			`Failed to fetch Merkle proof for commitment ${commitment}:`,
			err,
		);
		throw err;
	}
}

async function fetchMerkleProofs(
	commitments: string[],
	relayerUrl: string,
): Promise<
	Map<
		string,
		{
			pathElements: string[];
			pathIndices: number[];
			index: number;
			root: string;
			nextIndex: number;
		}
	>
> {
	if (commitments.length === 0) {
		return new Map();
	}

	try {
		const response = await fetchWithRetry(
			`${relayerUrl}/merkle/proofs`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ commitments }),
			},
			3,
		);
		if (!response.ok) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				`Failed to fetch Merkle proofs: ${response.status} ${response.statusText}`,
				{
					endpoint: `${relayerUrl}/merkle/proofs`,
					statusCode: response.status,
				},
			);
		}

		const data = (await response.json()) as {
			root: string;
			nextIndex: number;
			results: Array<{
				success: boolean;
				commitment: string;
				index?: number;
				pathElements?: string[];
				pathIndices?: number[];
				error?: string;
			}>;
		};

		const map = new Map<
			string,
			{
				pathElements: string[];
				pathIndices: number[];
				index: number;
				root: string;
				nextIndex: number;
			}
		>();

		for (const result of data.results) {
			if (
				result.success &&
				result.pathElements &&
				result.pathIndices &&
				result.index !== undefined
			) {
				map.set(result.commitment, {
					pathElements: result.pathElements,
					pathIndices: result.pathIndices,
					index: result.index,
					root: data.root,
					nextIndex: data.nextIndex,
				});
			}
		}

		return map;
	} catch (err) {
		error("Failed to fetch Merkle proofs batch from API:", err);
		throw err;
	}
}

/**
 * Submit SPL withdraw request to relayer backend
 */
async function submitSplWithdrawTorelayer(
	params: unknown,
	relayerUrl: string,
): Promise<string> {
	try {
		log(
			"Submitting SPL withdraw request to relayer backend...",
			params,
		);

		const result = await postRelayerJson<{
			signature: string;
			success: boolean;
		}>(
			relayerUrl,
			"/withdraw/spl",
			params,
			"SPL withdraw request failed",
		);
		log("Response:", result);

		return result.signature;
	} catch (error) {
		log(
			"Failed to submit SPL withdraw request to relayer:",
			typeof error,
			error,
		);
		throw error;
	}
}

/**
 * Submit delayed SPL withdraw request to relayer backend
 */
async function submitDelayedSplWithdrawTorelayer(
	params: unknown,
	relayerUrl: string,
): Promise<{ delayedWithdrawalId: string; executeAt: string }> {
	try {
		log(
			"Submitting delayed SPL withdraw request to relayer backend...",
			params,
		);

		const result = await postRelayerJson<{
			success: boolean;
			delayedWithdrawalId: string;
			executeAt: string;
			delayMinutes: number;
			message: string;
		}>(
			relayerUrl,
			"/withdraw/spl/delayed",
			params,
			"Delayed SPL withdraw request failed",
		);
		log("Response:", result);

		return {
			delayedWithdrawalId: result.delayedWithdrawalId,
			executeAt: result.executeAt,
		};
	} catch (error) {
		log(
			"Failed to submit delayed SPL withdraw request to relayer:",
			typeof error,
			error,
		);
		throw error;
	}
}

/**
 * SPL Token Withdrawal Function
 *
 * @param recipient_address - Recipient wallet address (owner of the token account)
 * @param amount - Amount of tokens to withdraw (in base units)
 * @param mintAddress - SPL token mint address
 * @param signed - User's signed account information
 * @param connection - Solana connection
 * @param setStatus - Optional status update callback
 * @param hasher - Poseidon hasher instance
 * @param delayMinutes - Optional delay in minutes for scheduled withdrawal
 * @returns Promise with partial flag and success status
 */
export async function withdrawSpl(
	recipient_address: PublicKey,
	amount: number,
	mintAddress: string,
	signed: Signed,
	connection: Connection,
	relayerUrl: string, // Relayer URL to use
	setStatus?: StatusCallback,
	hasher?: LightWasm,
	delayMinutes?: number,
	maxRetries: number = 3,
	retryCount: number = 0,
	utxoWalletSigned?: Signed,
	utxoWalletSignTransaction?: (
		tx: VersionedTransaction,
	) => Promise<VersionedTransaction>,
	providedUtxos?: Utxo[], // Optional: provide specific UTXOs to use (for batch withdrawals)
	circuitPath: string = CIRCUIT_PATH, // Path to circuit files
	altAddress?: PublicKey, // Address Lookup Table address for transaction optimization
	referralCode?: string, // Optional: referral code for private fee sharing
): Promise<{
	isPartial: boolean;
	success?: boolean;
	signature?: string;
	signatures?: string[]; // For batch withdrawals
	delayedWithdrawalId?: string;
	executeAt?: string;
	error?: string; // Error message
}> {
	if (retryCount > 0) {
		log(` Retry attempt ${retryCount}/${maxRetries}`);
	}

	// Validate mint address
	let mint: PublicKey;
	try {
		mint = new PublicKey(mintAddress);
	} catch (error) {
		throw new ValidationError(
			ErrorCodes.INVALID_MINT_ADDRESS,
			"Invalid mint address provided",
			undefined,
			error instanceof Error ? error : undefined,
		);
	}

	// Convert mint address to numeric format using BLAKE2b-128 (~39 digits instead of ~76)
	const mintAddressNumeric = getSplMintId(mintAddress);

	// Calculate withdrawal fee
	let fee_amount = Math.floor(amount * (WITHDRAW_FEE_RATE / 100));
	amount -= fee_amount;
	let isPartial = false;

	try {
		// Initialize hasher and encryption service
		const lightWasm = requireHasher(hasher);

		// Determine which wallet signature to use for UTXO derivation
		const utxoSignature = utxoWalletSigned
			? utxoWalletSigned.signature
			: signed.signature;

		// Create encryption service for UTXO derivation (may use different wallet)
		const utxoEncryptionService = new EncryptionService();
		utxoEncryptionService.deriveEncryptionKeyFromSignature(
			utxoSignature,
		);

		// Derive PDAs
		const [treeAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("merkle_tree")],
			PROGRAM_ID,
		);

		const [treeTokenAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("tree_token")],
			PROGRAM_ID,
		);

		const globalConfigAccount = getGlobalConfigPDA();

		// Get relayer public key
		const relayerPubkey = await getRelayerPublicKey(relayerUrl);

		// Derive all required token accounts
		const tokenAccounts = await deriveTokenAccounts(
			recipient_address,
			mint,
			globalConfigAccount,
			FEE_RECIPIENT,
			relayerPubkey,
		);

		// Get tree state
		const { root, nextIndex: currentNextIndex } =
			await queryRemoteTreeState(relayerUrl);

		// Generate UTXO keypair from the UTXO wallet
		const utxoPrivateKey =
			utxoEncryptionService.deriveUtxoPrivateKey();
		const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

		// Fetch or use provided UTXOs
		let unspentUtxos: Utxo[];

		if (providedUtxos && providedUtxos.length > 0) {
			// Use the provided UTXOs (for batch withdrawals)
			log(
				`[SDK] Using ${providedUtxos.length} provided UTXOs`,
			);
			unspentUtxos = providedUtxos;
		} else {
			// Fetch existing UTXOs (using UTXO wallet if provided)
			// Force refresh on retries to avoid stale cache while relayer indexing catches up.
			const forceRefreshUtxos = retryCount > 0;
			const allUtxos = await getMyUtxos(
				utxoWalletSigned || signed,
				connection,
				relayerUrl,
				setStatus,
				lightWasm,
				forceRefreshUtxos,
			);

			// Filter for this specific mint and non-zero amounts
			// Use backwards-compatible matching to support both old and new mint ID formats
			const mintUtxos = allUtxos.filter(
				(utxo) =>
					mintIdMatches(
						utxo.mintAddress,
						mintAddress,
					) && utxo.amount.gt(new BN(0)),
			);

			// Check which UTXOs are unspent
			const utxoSpentStatuses = await Promise.all(
				mintUtxos.map((utxo) =>
					isUtxoSpent(connection, utxo),
				),
			);

			unspentUtxos = mintUtxos.filter(
				(_, index) => !utxoSpentStatuses[index],
			);
		}

		if (unspentUtxos.length < 1) {
			const errorMsg =
				"Need at least 1 unspent UTXO to perform a withdrawal. Your balance may not have been indexed yet by the relayer.";
			error(` ${errorMsg}`);

			// Throw error to trigger retry logic
			throw new ValidationError(
				ErrorCodes.NO_UNSPENT_UTXOS,
				errorMsg,
				{ retryCount, maxRetries },
			);
		}

		// Sort UTXOs by amount in descending order
		unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

		// Normal withdrawal with up to 2 UTXOs
		// Select inputs
		const firstInput = unspentUtxos[0];
		const secondInput =
			unspentUtxos.length > 1
				? unspentUtxos[1]
				: new Utxo({
						lightWasm,
						// Don't specify keypair - use random to avoid nullifier collisions
						amount: new BN("0"),
						mintAddress: mintAddressNumeric,
					});

		const inputs = [firstInput, secondInput];
		const totalInputAmount = firstInput.amount.add(
			secondInput.amount,
		);

		if (totalInputAmount.toNumber() === 0) {
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"No balance available for this token",
			);
		}

		// Validate sufficient balance for withdrawal + fees
		const totalRequired = amount + fee_amount;
		if (totalInputAmount.lt(new BN(totalRequired))) {
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				`Insufficient balance for withdrawal. Requested: ${amount} (+ ${fee_amount} fee = ${totalRequired} total), Available: ${totalInputAmount.toNumber()}`,
			);
		}

		// Calculate change amount
		const changeAmount = totalInputAmount
			.sub(new BN(amount))
			.sub(new BN(fee_amount));

		const commitments = await Promise.all(
			inputs.map(async (utxo) => {
				if (utxo.amount.eq(new BN(0))) {
					return null;
				}
				return utxo.getCommitment();
			}),
		);

		const realCommitments = commitments.filter(
			(c): c is string => !!c,
		);
		let proofMap = new Map<
			string,
			{
				pathElements: string[];
				pathIndices: number[];
				index: number;
				root: string;
				nextIndex: number;
			}
		>();

		if (realCommitments.length > 1) {
			proofMap = await fetchMerkleProofs(
				realCommitments,
				relayerUrl,
			);
		} else if (realCommitments.length === 1) {
			const proof = await fetchMerkleProof(
				realCommitments[0],
				relayerUrl,
			);
			proofMap.set(realCommitments[0], proof);
		}

		// Get Merkle proofs
		const inputMerkleProofs = inputs.map((utxo, idx) => {
			if (utxo.amount.eq(new BN(0))) {
				return {
					pathElements: [
						...new Array(
							MERKLE_TREE_DEPTH,
						).fill("0"),
					],
					pathIndices:
						Array(MERKLE_TREE_DEPTH).fill(
							0,
						),
					index: 0,
					root: "",
					nextIndex: 0,
				};
			}
			const commitment = commitments[idx] as string;
			const proof = proofMap.get(commitment);
			if (!proof) {
				throw new NetworkError(
					ErrorCodes.API_FETCH_FAILED,
					`Missing Merkle proof for commitment ${commitment}`,
					{
						endpoint: `${relayerUrl}/merkle/proofs`,
					},
				);
			}
			return proof;
		});

		// CRITICAL FIX: Update UTXO indices with correct values from tree BEFORE calculating nullifiers
		inputs.forEach((utxo, idx) => {
			if (
				!utxo.amount.eq(new BN(0)) &&
				inputMerkleProofs[idx].index !== undefined
			) {
				utxo.index = inputMerkleProofs[idx].index;
			}
		});

		const inputMerklePathElements = inputMerkleProofs.map(
			(proof) => proof.pathElements,
		);
		const inputMerklePathIndices = inputMerkleProofs.map(
			(proof) => proof.index || 0,
		);

		// Create outputs
		const outputs = [
			new Utxo({
				lightWasm,
				amount: changeAmount.toString(),
				keypair: utxoKeypair,
				index: currentNextIndex,
				mintAddress: mintAddressNumeric,
			}),
			new Utxo({
				lightWasm,
				amount: new BN("0"),
				keypair: utxoKeypair,
				index: currentNextIndex + 1,
				mintAddress: mintAddressNumeric,
			}),
		];

		// Calculate public amount (negative for withdrawal)
		const extAmount = -amount;
		const publicAmountForCircuit = new BN(extAmount)
			.sub(new BN(fee_amount))
			.add(FIELD_SIZE)
			.mod(FIELD_SIZE);

		// Generate nullifiers and commitments
		const inputNullifiers = await Promise.all(
			inputs.map((x) => x.getNullifier()),
		);

		const outputCommitments = await Promise.all(
			outputs.map((x) => x.getCommitment()),
		);

		// Encrypt UTXOs with UTXO wallet's encryption service
		const encryptedOutput1 = utxoEncryptionService.encryptUtxo(
			outputs[0],
		);
		const encryptedOutput2 = utxoEncryptionService.encryptUtxo(
			outputs[1],
		);

		// Create ExtData
		// For SPL: recipient and feeRecipient must be TOKEN ACCOUNTS (ATAs), not wallet addresses
		const extData = {
			recipient: tokenAccounts.recipientTokenAccount,
			extAmount: new BN(extAmount),
			encryptedOutput1: encryptedOutput1,
			encryptedOutput2: encryptedOutput2,
			fee: new BN(fee_amount),
			feeRecipient: tokenAccounts.feeRecipientAta,
			mintAddress: mint,
		};

		// Use PublicKey format to match on-chain TransactSpl calculation
		// (UTXO commitments use numeric, but extDataHash is separate)
		const calculatedExtDataHash = getExtDataHash(extData, false);

		// Create proof input (using mintAddressNumeric from top of function)
		const input = {
			root: root,
			inputNullifier: inputNullifiers,
			outputCommitment: outputCommitments,
			publicAmount: publicAmountForCircuit.toString(),
			extDataHash: calculatedExtDataHash,
			inAmount: inputs.map((x) => x.amount.toString(10)),
			inPrivateKey: inputs.map((x) => x.keypair.privkey),
			inBlinding: inputs.map((x) => x.blinding.toString(10)),
			inPathIndices: inputMerklePathIndices,
			inPathElements: inputMerklePathElements,
			outAmount: outputs.map((x) => x.amount.toString(10)),
			outBlinding: outputs.map((x) =>
				x.blinding.toString(10),
			),
			outPubkey: outputs.map((x) => x.keypair.pubkey),
			mintAddress: mintAddressNumeric,
		};

		setStatus?.(`(generating ZK proof...)`);

		// Generate proof
		const { proof, publicSignals } = await prove(
			input,
			circuitPath,
		);

		const proofInBytes = parseProofToBytesArray(proof);
		const inputsInBytes = parseToBytesArray(publicSignals);

		const proofToSubmit = {
			proofA: proofInBytes.proofA,
			proofB: proofInBytes.proofB.flat(),
			proofC: proofInBytes.proofC,
			root: inputsInBytes[0],
			publicAmount: inputsInBytes[1],
			extDataHash: inputsInBytes[2],
			inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
			outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
		};

		// Find PDAs
		const { nullifier0PDA, nullifier1PDA } =
			deriveNullifierPairPdas(proofToSubmit);

		// Serialize proof and extData with SPL discriminator
		const serializedProof = serializeProofAndExtData(
			proofToSubmit,
			extData,
			TRANSACT_SPL_IX_DISCRIMINATOR,
		);

		// Prepare withdraw parameters for relayer backend
		const withdrawParams = {
			serializedProof: serializedProof.toString("base64"),
			treeAccount: treeAccount.toString(),
			treeTokenAccount: treeTokenAccount.toString(), // SOL account for tree (required by backend)
			nullifier0PDA: nullifier0PDA.toString(),
			nullifier1PDA: nullifier1PDA.toString(),
			globalConfigAccount: globalConfigAccount.toString(),
			recipient: recipient_address.toString(),
			feeRecipientAccount: FEE_RECIPIENT.toString(), // SOL fee recipient (required by backend)
			mintAddress: mint.toString(),
			signerTokenAccount:
				tokenAccounts.signerTokenAccount.toString(),
			recipientTokenAccount:
				tokenAccounts.recipientTokenAccount.toString(),
			treeAta: tokenAccounts.treeAta.toString(),
			feeRecipientAta:
				tokenAccounts.feeRecipientAta.toString(),
			extAmount: extAmount,
			encryptedOutput1: uint8ArrayToBase64(encryptedOutput1),
			encryptedOutput2: uint8ArrayToBase64(encryptedOutput2),
			fee: fee_amount,
			lookupTableAddress: altAddress
				? altAddress.toString()
				: "",
			...(referralCode ? { referrer: referralCode } : {}),
		};

		// Check if root changed before submitting transaction
		try {
			const updatedData =
				await queryRemoteTreeState(relayerUrl);
			if (updatedData.root !== root) {
				warn(
					"Root changed before transaction submission, retrying with updated state...",
				);

				// Recursively call withdrawSpl again with updated state
				return await withdrawSpl(
					recipient_address,
					amount,
					mintAddress,
					signed,
					connection,
					relayerUrl,
					setStatus,
					hasher,
					delayMinutes,
					maxRetries,
					retryCount,
					utxoWalletSigned,
					utxoWalletSignTransaction,
					providedUtxos,
					circuitPath,
					altAddress,
					referralCode,
				);
			}
		} catch (err) {
			error(
				"Failed to verify root before submission - root changed during transaction preparation",
			);
			throw new TransactionError(
				ErrorCodes.ROOT_VERIFICATION_FAILED,
				"Merkle root changed during transaction preparation. This usually means the tree was updated by another transaction.",
				{ retryCount, maxRetries },
				err instanceof Error ? err : undefined,
			);
		}

		// Check if this should be a delayed withdrawal
		if (delayMinutes && delayMinutes > 0) {
			// Submit delayed withdrawal
			setStatus?.(`(scheduling delayed withdrawal...)`);
			const delayedParams = {
				...withdrawParams,
				delayMinutes: delayMinutes,
				userPubkey: signed.publicKey.toString(),
			};

			const delayedResult =
				await submitDelayedSplWithdrawTorelayer(
					delayedParams,
					relayerUrl,
				);

			return {
				isPartial,
				success: true,
				delayedWithdrawalId:
					delayedResult.delayedWithdrawalId,
				executeAt: delayedResult.executeAt,
			};
		} else {
			// Submit immediate withdrawal
			setStatus?.(`(submitting transaction to relayer...)`);
			const signature = await submitSplWithdrawTorelayer(
				withdrawParams,
				relayerUrl,
			);
			log("Transaction signature:", signature);

			// Wait for confirmation
			setStatus?.(
				`(waiting for transaction confirmation...)`,
			);

			// Check if UTXOs were added to the tree by polling the relayer
			// This ensures the change UTXO is indexed before we return
			try {
				const expectedNextIndex = currentNextIndex + 2;
				const maxPollingAttempts = 100;
				const pollingIntervalMs = 1000; // 1 second between attempts

				let attempts = 0;
				let treeStateMatches = false;

				while (attempts < maxPollingAttempts) {
					const updatedTreeState =
						await queryRemoteTreeState(
							relayerUrl,
						);

					if (
						updatedTreeState.nextIndex ===
						expectedNextIndex
					) {
						log(
							"Withdrawal complete. Change UTXO added to Merkle tree.",
						);
						treeStateMatches = true;
						break;
					} else if (
						updatedTreeState.nextIndex >
						expectedNextIndex
					) {
						// Tree progressed beyond our expected index - our UTXOs are definitely in
						log(
							`Tree progressed beyond expected index (expected ${expectedNextIndex}, got ${updatedTreeState.nextIndex}). Change UTXO confirmed in tree.`,
						);
						treeStateMatches = true;
						break;
					} else {
						// Tree hasn't caught up yet
						attempts++;
						if (
							attempts <
							maxPollingAttempts
						) {
							warn(
								`[SDK WARNING] Tree index mismatch: expected ${expectedNextIndex}, got ${updatedTreeState.nextIndex} - retrying (${attempts}/${maxPollingAttempts})...`,
							);
							await new Promise(
								(resolve) =>
									setTimeout(
										resolve,
										pollingIntervalMs,
									),
							);
						}
					}
				}

				if (!treeStateMatches) {
					const finalTreeState =
						await queryRemoteTreeState(
							relayerUrl,
						);
					warn(
						`[SDK WARNING] Tree index mismatch after ${maxPollingAttempts} attempts: expected ${expectedNextIndex}, got ${finalTreeState.nextIndex}. Change UTXO may not be immediately available.`,
					);
				}
			} catch (err) {
				error(
					"Failed to verify tree state after withdrawal:",
					err,
				);
				warn(
					`[SDK WARNING] Could not verify change UTXO was indexed. Balance may not be immediately available.`,
				);
			}

			return { isPartial, success: true, signature };
		}
		} catch (err: unknown) {
		// Parse error to detect specific failure reasons
		const errorInfo = parseTransactionError(err);

		// Never retry if the user rejected the wallet prompt (common code=4001).
		if (isUserRejectedError(err)) {
			error(" SPL withdrawal aborted: user rejected wallet request.");
			throw err;
		}

		// Special handling for NO_UNSPENT_UTXOS - add delay for relayer indexing
		const isNoUtxosError =
			err instanceof ValidationError &&
			err.code === ErrorCodes.NO_UNSPENT_UTXOS;

		if (errorInfo.isRootMismatch) {
			error(
				" Root mismatch detected - tree was updated during transaction",
			);
			if (retryCount < maxRetries) {
				error(
					` Automatically retrying with updated root (attempt ${retryCount + 1}/${maxRetries})...`,
				);
				return await withdrawSpl(
					recipient_address,
					amount,
					mintAddress,
					signed,
					connection,
					relayerUrl,
					setStatus,
					hasher,
					delayMinutes,
					maxRetries,
					retryCount + 1,
					utxoWalletSigned,
					utxoWalletSignTransaction,
					providedUtxos,
					circuitPath,
					altAddress,
					referralCode,
				);
			}
		}

		if (errorInfo.isNullifierAlreadyUsed) {
			error(" UTXO already spent (nullifier already used)");
			throw new TransactionError(
				ErrorCodes.NULLIFIER_ALREADY_USED,
				"One or more UTXOs have already been spent. Please refresh your balance.",
				{ error: errorInfo.message },
			);
		}

		if (errorInfo.isInsufficientFunds) {
			error(" Insufficient funds for transaction");
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"Insufficient funds to complete the SPL withdrawal. Check your balance and try again.",
				{ error: errorInfo.message },
			);
		}

		// General retry for other errors
		if (retryCount < maxRetries) {
			error(` SPL withdrawal failed:`, err);
			error(`Full error details: ${serializeError(err)}`);

				if (isNoUtxosError) {
					error(
						` No UTXOs available, retrying (attempt ${
							retryCount + 1
						}/${maxRetries})...`,
					);
					const delayMs = Math.min(
						2000 * (retryCount + 1),
						10000,
					);
					error(
						` Waiting ${delayMs}ms for relayer indexing before retry...`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, delayMs),
					);
				} else {
					error(
						` Retrying SPL withdrawal (attempt ${
						retryCount + 1
					}/${maxRetries})...`,
				);
			}

			return await withdrawSpl(
				recipient_address,
				amount,
				mintAddress,
				signed,
				connection,
				relayerUrl,
				setStatus,
				hasher,
				delayMinutes,
				maxRetries,
				retryCount + 1,
				utxoWalletSigned,
				utxoWalletSignTransaction,
				providedUtxos,
				circuitPath,
				altAddress,
				referralCode,
			);
		}

		// Log full error before throwing
		error(
			` SPL withdrawal failed after ${maxRetries} retries:`,
			err,
		);
		error(`Full error details:\n${serializeError(err)}`);
		throw err;
	}
}
