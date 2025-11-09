import {
	Connection,
	LAMPORTS_PER_SOL,
	PublicKey,
	VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Buffer } from "buffer";
import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";
import {
	parseProofToBytesArray,
	parseToBytesArray,
	prove,
} from "../utils/prover";
import { useExistingALT } from "./address_lookup_table";
import {
	ALT_ADDRESS,
	CIRCUIT_PATH,
	FEE_RECIPIENT,
	FIELD_SIZE,
	relayer_API_URL,
	MERKLE_TREE_DEPTH,
	PROGRAM_ID,
	WITHDRAW_FEE_RATE,
} from "./constants";
import {
	EncryptionService,
	serializeProofAndExtData,
	uint8ArrayToBase64,
} from "./encryption";
import type { Signed } from "./getAccountSign";
import type { StatusCallback } from "../types/internal";
import { log, warn, error as error, serializeError } from "./logger";
import { getExtDataHash } from "./getExtDataHash";
import { getMyUtxos, isUtxoSpent } from "./getMyUtxos";
import {
	validateWithdrawalAmount,
	validatePublicKey,
	validateDelayMinutes,
	validateTransactionSize,
	parseTransactionError,
} from "./validation";
import { ErrorCodes, ValidationError, NetworkError, TransactionError } from '../errors';
import { fetchWithRetry } from "./fetchWithRetry";
// relayer API endpoint

// Function to query remote tree state from relayer API
async function queryRemoteTreeState(): Promise<{
	root: string;
	nextIndex: number;
}> {
	try {
		const response = await fetchWithRetry(
			`${relayer_API_URL}/merkle/root`,
			undefined,
			3,
		);
		if (!response.ok) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				`Failed to fetch Merkle root and nextIndex: ${response.status} ${response.statusText}`,
				{ endpoint: `${relayer_API_URL}/merkle/root`, statusCode: response.status }
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

// Function to fetch Merkle proof from API for a given commitment
// Returns proof along with the root it was generated from to ensure consistency
async function fetchMerkleProof(commitment: string): Promise<{
	pathElements: string[];
	pathIndices: number[];
	root: string;
	nextIndex: number;
	index: number;
}> {
	try {
		const response = await fetchWithRetry(
			`${relayer_API_URL}/merkle/proof/${commitment}`,
			undefined,
			3,
		);
		if (!response.ok) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				`Failed to fetch Merkle proof: ${response.status} ${response.statusText}`,
				{ endpoint: `${relayer_API_URL}/merkle/proof/${commitment}`, statusCode: response.status }
			);
		}
		const data = (await response.json()) as {
			pathElements: string[];
			pathIndices: number[];
			root: string;
			nextIndex: number;
			index: number;
		};
		log(
			` Fetched Merkle proof with ${data.pathElements.length} elements (root: ${data.root}, index: ${data.index})`,
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

// Find nullifier PDAs for the given proof
function findNullifierPDAs(proof: any) {
	const [nullifier0PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier0"),
			Buffer.from(proof.inputNullifiers[0]),
		],
		PROGRAM_ID,
	);

	const [nullifier1PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier1"),
			Buffer.from(proof.inputNullifiers[1]),
		],
		PROGRAM_ID,
	);

	return { nullifier0PDA, nullifier1PDA };
}

// Function to submit withdraw request to relayer backend
async function submitWithdrawTorelayer(params: any): Promise<string> {
	try {
		log("Submitting withdraw request to relayer backend...");

		const response = await fetchWithRetry(
			`${relayer_API_URL}/withdraw`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(params),
			},
			3,
		);

		log(
			`Relayer response status: ${response.status} ${response.statusText}`,
		);

		if (!response.ok) {
			const errorText = await response.text();
			log("Relayer error response body:", errorText);

			let errorData;
			try {
				errorData = JSON.parse(errorText) as {
					error?: string;
				};
			} catch (e) {
				throw new Error(
					`Withdraw request failed (${response.status}): ${errorText}`,
				);
			}

			let errorMsg: string;
			if (typeof errorData.error === 'string') {
				errorMsg = errorData.error;
			} else if (errorData.error) {
				errorMsg = JSON.stringify(errorData.error, (_key, value) => {
					if (value instanceof Error) {
						return {
							name: value.name,
							message: value.message,
							stack: value.stack
						};
					}
					return value;
				}, 2);
			} else {
				errorMsg = JSON.stringify(errorData, null, 2);
			}
			throw new NetworkError(
				ErrorCodes.RELAYER_ERROR,
				`Withdraw request failed (${response.status}): ${errorMsg}`,
				{ endpoint: `${relayer_API_URL}/withdraw`, statusCode: response.status }
			);
		}

		const result = (await response.json()) as {
			signature: string;
			success: boolean;
			message: string;
		};
		log("Response:", result);

		return result.signature;
	} catch (err) {
		error("Failed to submit withdraw request to relayer:", err);
		throw err;
	}
}

// Function to submit delayed withdraw request to relayer backend
async function submitDelayedWithdrawTorelayer(
	params: any,
): Promise<{ delayedWithdrawalId: number; executeAt: string }> {
	try {
		log(
			"Submitting delayed withdraw request to relayer backend...",
			params,
		);

		const response = await fetchWithRetry(
			`${relayer_API_URL}/withdraw/delayed`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(params),
			},
			3,
		);

		if (!response.ok) {
			let errorMsg: string;
			try {
				const errorData = (await response.json()) as {
					error?: any;
				};
				if (typeof errorData.error === 'string') {
					errorMsg = errorData.error;
				} else if (errorData.error) {
					errorMsg = JSON.stringify(errorData.error, (_key, value) => {
						if (value instanceof Error) {
							return {
								name: value.name,
								message: value.message,
								stack: value.stack
							};
						}
						return value;
					}, 2);
				} else {
					errorMsg = JSON.stringify(errorData, null, 2);
				}
			} catch {
				errorMsg = await response.text();
			}
			throw new NetworkError(
				ErrorCodes.RELAYER_ERROR,
				`Delayed withdraw request failed (${response.status}): ${errorMsg}`,
				{ endpoint: `${relayer_API_URL}/withdraw/delayed`, statusCode: response.status }
			);
		}

		const result = (await response.json()) as {
			success: boolean;
			delayedWithdrawalId: number;
			executeAt: string;
			delayMinutes: number;
			message: string;
		};
		log("Response:", result);

		return {
			delayedWithdrawalId: result.delayedWithdrawalId,
			executeAt: result.executeAt,
		};
	} catch (error) {
		log(
			"Failed to submit delayed withdraw request to relayer:",
			typeof error,
			error,
		);
		throw error;
	}
}

export async function withdraw(
	recipient_address: PublicKey,
	amount_in_sol: number,
	signed: Signed,
	connection: Connection,
	setStatus?: StatusCallback,
	hasher?: any,
	delayMinutes?: number,
	maxRetries: number = 3,
	retryCount: number = 0,
	utxoWalletSigned?: Signed, // Optional: different wallet's signature for UTXO keypair derivation
	utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>, // Optional: signing callback for UTXO wallet
	providedUtxos?: Utxo[], // Optional: provide specific UTXOs to use (for batch withdrawals)
	relayerUrl: string = relayer_API_URL, // Relayer URL to use
	circuitPath: string = CIRCUIT_PATH, // Path to circuit files
): Promise<{
	isPartial: boolean;
	success?: boolean;
	signature?: string;
	signatures?: string[]; // For batch withdrawals
	delayedWithdrawalId?: number;
	executeAt?: string;
	error?: string; // Error message
}> {
	if (retryCount > 0) {
		log(` Retry attempt ${retryCount}/${maxRetries}`);
	}

	// Track locked commitments for cleanup
	let lockedCommitments: string[] = [];

	// Validate recipient address
	recipient_address = validatePublicKey(
		recipient_address,
		"recipient address",
	);

	// Validate delay minutes if provided
	validateDelayMinutes(delayMinutes);

	let amount_in_lamports = amount_in_sol * LAMPORTS_PER_SOL;

	let fee_amount_in_lamports = Math.floor(
		amount_in_lamports * (WITHDRAW_FEE_RATE / 100),
	);

	amount_in_lamports -= fee_amount_in_lamports;
	let isPartial = false;
	await useExistingALT(
		connection,
		ALT_ADDRESS,
	);
	try {
		// Initialize the light protocol hasher
		const lightWasm = hasher;

		// Initialize the encryption service
		const encryptionService = new EncryptionService();

		// Generate encryption key from the user signature
		encryptionService.deriveEncryptionKeyFromSignature(
			signed.signature,
		);

		// Derive PDA (Program Derived Addresses) for the tree account and other required accounts
		const [treeAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("merkle_tree")],
			PROGRAM_ID,
		);

		// const [feeRecipientAccount] = PublicKey.findProgramAddressSync(
		//     [Buffer.from('fee_recipient'), DEPLOYER_ID.toBuffer()],
		//     PROGRAM_ID
		// );

		const [treeTokenAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("tree_token")],
			PROGRAM_ID,
		);

		const [globalConfigAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("global_config")],
			PROGRAM_ID,
		);

		// Get all relevant balances before transaction
		// Get current tree state
		const { root, nextIndex: currentNextIndex } =
			await queryRemoteTreeState();

		// Determine which wallet signature to use for UTXO derivation
		const utxoSignature = utxoWalletSigned ? utxoWalletSigned.signature : signed.signature;

		// Create encryption service for UTXO derivation (may use different wallet)
		const utxoEncryptionService = new EncryptionService();
		utxoEncryptionService.deriveEncryptionKeyFromSignature(utxoSignature);

		// Generate a deterministic private key derived from the UTXO wallet keypair
		const utxoPrivateKey = utxoEncryptionService.deriveUtxoPrivateKey();

		// Create a UTXO keypair that will be used for all inputs and outputs
		const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

		// Fetch or use provided UTXOs
		let unspentUtxos: Utxo[];

		if (providedUtxos) {
			// Use the provided UTXOs (for batch withdrawals)
			log(`[SDK] Using ${providedUtxos.length} provided UTXOs`);
			unspentUtxos = providedUtxos;
		} else {
			// Fetch existing UTXOs for this UTXO wallet (may be different from transaction wallet)
			const allUtxos = await getMyUtxos(
				utxoWalletSigned || signed, // Use UTXO wallet if provided, otherwise transaction wallet
				connection,
				setStatus,
				hasher,
			);

			// Filter out zero-amount UTXOs (dummy UTXOs that can't be spent)
			const nonZeroUtxos = allUtxos.filter((utxo) =>
				utxo.amount.gt(new BN(0)),
			);

			// Filter to only include SOL UTXOs (mint address = "11111111111111111111111111111112")
			const solUtxos = nonZeroUtxos.filter(
				(utxo) =>
					utxo.mintAddress ===
					"11111111111111111111111111111112",
			);

			// Check which SOL UTXOs are unspent
			const utxoSpentStatuses = await Promise.all(
				solUtxos.map((utxo) => isUtxoSpent(connection, utxo)),
			);

			// Filter to only include unspent SOL UTXOs
			unspentUtxos = solUtxos.filter(
				(_, index) => !utxoSpentStatuses[index],
			);
		}

		// Calculate total unspent UTXO balance
		const totalUnspentBalance = unspentUtxos.reduce(
			(sum, utxo) => sum.add(utxo.amount),
			new BN(0),
		);

		if (unspentUtxos.length < 1) {
			const errorMsg = "Need at least 1 unspent UTXO to perform a withdrawal. Your balance may not have been indexed yet by the relayer.";
			error(` ${errorMsg}`);

			// Throw error to trigger retry logic
			throw new ValidationError(
				ErrorCodes.NO_UNSPENT_UTXOS,
				errorMsg,
				{ retryCount, maxRetries }
			);
		}

		// Validate withdrawal amount (this may adjust amount for partial withdrawals)
		const validationResult = validateWithdrawalAmount(
			amount_in_sol,
			totalUnspentBalance,
			fee_amount_in_lamports,
		);

		if (validationResult.isPartial) {
			isPartial = true;
			amount_in_lamports = Math.floor(
				validationResult.adjustedAmount *
					LAMPORTS_PER_SOL,
			);
		}

		// Sort UTXOs by amount in descending order to use the largest ones first
		unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

		// Check if we need more than 2 UTXOs for this withdrawal
		const totalNeeded = new BN(amount_in_lamports).add(new BN(fee_amount_in_lamports));
		const firstTwoTotal = unspentUtxos.length >= 2
			? unspentUtxos[0].amount.add(unspentUtxos[1].amount)
			: unspentUtxos[0].amount;

		// If we need >2 UTXOs, use batch withdrawal logic
		if (firstTwoTotal.lt(totalNeeded) && unspentUtxos.length > 2) {
			log(`[SDK] Need more than 2 UTXOs for withdrawal (have ${unspentUtxos.length} UTXOs), using batch withdrawal...`);

			// Import batch withdrawal utilities
			const { planBatchWithdrawals } = await import("./batch-withdraw.js");

			// Plan the batch withdrawals
			const plan = planBatchWithdrawals(
				amount_in_lamports,
				WITHDRAW_FEE_RATE,
				unspentUtxos,
			);

			if (!plan || plan.withdrawals.length === 0) {
				throw new ValidationError(
					ErrorCodes.INVALID_STATE,
					"Unable to plan batch withdrawals with available UTXOs"
				);
			}

			log(`[SDK] Executing ${plan.withdrawals.length} batch withdrawals...`);
			const signatures: string[] = [];
			let totalWithdrawn = 0;

			// Execute each withdrawal sequentially to avoid conflicts
			for (let i = 0; i < plan.withdrawals.length; i++) {
				const withdrawal = plan.withdrawals[i];
				const amountInSol = withdrawal.amount / LAMPORTS_PER_SOL;

				setStatus?.(`Processing withdrawal ${i + 1}/${plan.withdrawals.length}...`);

				// Recursively call withdraw with the specific UTXOs
				const result = await withdraw(
					recipient_address,
					amountInSol,
					signed,
					connection,
					setStatus,
					hasher,
					delayMinutes,
					maxRetries,
					retryCount,
					utxoWalletSigned,
					utxoWalletSignTransaction,
					withdrawal.utxos, // Provide specific UTXOs for this withdrawal
				);

				if (result.success && result.signature) {
					signatures.push(result.signature);
					totalWithdrawn += withdrawal.amount;
				} else {
					warn(`[SDK WARNING] Batch withdrawal ${i + 1} failed: ${result.error}`);
				}

				// Small delay between withdrawals
				if (i < plan.withdrawals.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			if (signatures.length === 0) {
				throw new NetworkError(
					ErrorCodes.TRANSACTION_FAILED,
					"All batch withdrawals failed"
				);
			}

			log(`[SDK] Batch withdrawal complete: ${signatures.length}/${plan.withdrawals.length} successful`);

			return {
				isPartial: totalWithdrawn < amount_in_lamports,
				success: true,
				signature: signatures[0], // First signature for backward compatibility
				signatures: signatures, // All signatures
			};
		}

		// Normal withdrawal with up to 2 UTXOs
		// Use the largest UTXO as first input, and either second largest UTXO or dummy UTXO as second input
		const firstInput = unspentUtxos[0];

		const secondInput =
			unspentUtxos.length > 1
				? unspentUtxos[1]
				: new Utxo({
						lightWasm,
						// Don't specify keypair - use random to avoid nullifier collisions
						amount: new BN("0"),
				  });

		// Lock the UTXOs we're about to use
		const utxosToLock = [firstInput];
		if (secondInput.amount.gt(new BN(0))) {
			utxosToLock.push(secondInput);
		}

		lockedCommitments = await Promise.all(
			utxosToLock.map((u) => u.getCommitment()),
		);

		const { getUtxoLockService } = await import("./utxoLock");
		const lockService = getUtxoLockService();
		const locked = await lockService.tryLockWithRetry(
			lockedCommitments,
			"withdrawal",
			3,
			1000,
		);

		if (!locked) {
			throw new ValidationError(
				ErrorCodes.INVALID_STATE,
				"Could not acquire locks on UTXOs. They may be in use by another operation."
			);
		}

		// const secondInput = new Utxo({
		//     lightWasm,
		//     keypair: await UtxoKeypair.generateNew(lightWasm),
		//     amount: new BN('0')
		// });

		const inputs = [firstInput, secondInput];

		// Validate transaction size
		validateTransactionSize({
			numInputs: secondInput.amount.gt(new BN(0)) ? 2 : 1,
			numOutputs: 2,
			hasProof: true,
			numAdditionalAccounts: 5,
		});
		const totalInputAmount = firstInput.amount.add(
			secondInput.amount,
		);

		if (totalInputAmount.toNumber() === 0) {
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"No balance available for withdrawal"
			);
		}

		// Validate sufficient balance for withdrawal + fees
		const totalRequired = amount_in_lamports + fee_amount_in_lamports;
		if (totalInputAmount.lt(new BN(totalRequired))) {
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				`Insufficient balance for withdrawal. Requested: ${amount_in_lamports / 1e9} SOL (+ ${fee_amount_in_lamports / 1e9} SOL fee = ${totalRequired / 1e9} SOL total), Available: ${totalInputAmount.toNumber() / 1e9} SOL`
			);
		}

		// Calculate the change amount (what's left after withdrawal and fee)
		const changeAmount = totalInputAmount
			.sub(new BN(amount_in_lamports))
			.sub(new BN(fee_amount_in_lamports));

		// Get Merkle proofs for both input UTXOs
		const inputMerkleProofs = await Promise.all(
			inputs.map(async (utxo) => {
				// For dummy UTXO (amount is 0), use a zero-filled proof
				if (utxo.amount.eq(new BN(0))) {
					return {
						pathElements: [
							...new Array(
								MERKLE_TREE_DEPTH,
							).fill("0"),
						],
						pathIndices:
							Array(
								MERKLE_TREE_DEPTH,
							).fill(0),
						index: 0,
						root: "",
						nextIndex: 0,
					};
				}
				// For real UTXOs, fetch the proof from API
				const commitment = await utxo.getCommitment();
				return fetchMerkleProof(commitment);
			}),
		);

		// IMPORTANT: Update UTXO indices with correct values from tree BEFORE calculating nullifiers
		// The encrypted UTXO data may have wrong indices, but the relayer knows the truth
		inputs.forEach((utxo, idx) => {
			if (
				!utxo.amount.eq(new BN(0)) &&
				inputMerkleProofs[idx].index !== undefined
			) {
				utxo.index = inputMerkleProofs[idx].index;
			}
		});

		// Extract path elements and indices
		const inputMerklePathElements = inputMerkleProofs.map(
			(proof) => proof.pathElements,
		);
		// Use the actual tree index from the relayer, not the encrypted UTXO data
		const inputMerklePathIndices = inputMerkleProofs.map(
			(proof) => proof.index || 0,
		);

		// Create outputs: first output is change, second is dummy (required by protocol)
		const outputs = [
			new Utxo({
				lightWasm,
				amount: changeAmount.toString(),
				keypair: utxoKeypair,
				index: currentNextIndex,
			}), // Change output
			new Utxo({
				lightWasm,
				amount: new BN("0"),
				keypair: utxoKeypair,
				index: currentNextIndex + 1,
			}), // Empty UTXO
		];

		// For withdrawals, extAmount is negative (funds leaving the system)
		const extAmount = -amount_in_lamports;
		const publicAmountForCircuit = new BN(extAmount)
			.sub(new BN(fee_amount_in_lamports))
			.add(FIELD_SIZE)
			.mod(FIELD_SIZE);

		// Generate nullifiers and commitments
		const inputNullifiers = await Promise.all(
			inputs.map((x) => x.getNullifier()),
		);
		const outputCommitments = await Promise.all(
			outputs.map((x) => x.getCommitment()),
		);

		// Encrypt the UTXO data using a compact format that includes the keypair
		// Use UTXO encryption service (must match the keypair derivation)
		const encryptedOutput1 = utxoEncryptionService.encryptUtxo(
			outputs[0],
		);
		const encryptedOutput2 = utxoEncryptionService.encryptUtxo(
			outputs[1],
		);

		// Create the withdrawal ExtData with real encrypted outputs
		const extData = {
			// it can be any address
			recipient: recipient_address,
			extAmount: new BN(extAmount),
			encryptedOutput1: encryptedOutput1,
			encryptedOutput2: encryptedOutput2,
			fee: new BN(fee_amount_in_lamports),
			feeRecipient: FEE_RECIPIENT,
			mintAddress: inputs[0].mintAddress,
		};

		// Calculate the extDataHash with the encrypted outputs
		const calculatedExtDataHash = getExtDataHash(extData);

		// Create the input for the proof generation
		const input = {
			// Common transaction data
			root: root,
			inputNullifier: inputNullifiers,
			outputCommitment: outputCommitments,
			publicAmount: publicAmountForCircuit.toString(),
			extDataHash: calculatedExtDataHash,

			// Input UTXO data (UTXOs being spent)
			inAmount: inputs.map((x) => x.amount.toString(10)),
			inPrivateKey: inputs.map((x) => x.keypair.privkey),
			inBlinding: inputs.map((x) => x.blinding.toString(10)),
			inPathIndices: inputMerklePathIndices,
			inPathElements: inputMerklePathElements,

			// Output UTXO data (UTXOs being created)
			outAmount: outputs.map((x) => x.amount.toString(10)),
			outBlinding: outputs.map((x) =>
				x.blinding.toString(10),
			),
			outPubkey: outputs.map((x) => x.keypair.pubkey),

			// new mint address
			mintAddress: inputs[0].mintAddress,
		};

		setStatus?.(`(generating ZK proof...)`);

		// Generate the zero-knowledge proof
		const { proof, publicSignals } = await prove(
			input,
			circuitPath,
		);

		// Parse the proof and public signals into byte arrays
		const proofInBytes = parseProofToBytesArray(proof);
		const inputsInBytes = parseToBytesArray(publicSignals);

		// Create the proof object to submit to the program
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

		// Find PDAs for nullifiers
		const { nullifier0PDA, nullifier1PDA } =
			findNullifierPDAs(proofToSubmit);

		// Serialize the proof and extData
		const serializedProof = serializeProofAndExtData(
			proofToSubmit,
			extData,
		);

		// Prepare withdraw parameters for relayer backend
		const withdrawParams = {
			serializedProof: serializedProof.toString("base64"),
			treeAccount: treeAccount.toString(),
			nullifier0PDA: nullifier0PDA.toString(),
			nullifier1PDA: nullifier1PDA.toString(),
			treeTokenAccount: treeTokenAccount.toString(),
			globalConfigAccount: globalConfigAccount.toString(),
			recipient: recipient_address.toString(),
			feeRecipientAccount: FEE_RECIPIENT.toString(),
			extAmount: extAmount,
			encryptedOutput1: uint8ArrayToBase64(encryptedOutput1),
			encryptedOutput2: uint8ArrayToBase64(encryptedOutput2),
			fee: fee_amount_in_lamports,
			lookupTableAddress: ALT_ADDRESS.toString(),
		};

		// Check if root changed before submitting transaction
		try {
			const updatedData = await queryRemoteTreeState();
			if (updatedData.root !== root) {
				warn(
					"Root changed before transaction submission, retrying with updated state..."
				);

				// Recursively call withdraw again with updated state
				return await withdraw(
					recipient_address,
					amount_in_sol,
					signed,
					connection,
					setStatus,
					hasher,
					delayMinutes,
					maxRetries,
					retryCount,
					utxoWalletSigned,
					utxoWalletSignTransaction,
				);
			}
		} catch (err) {
			error(
				"Failed to verify root before submission - root changed during transaction preparation",
			);

			// Unlock UTXOs if we locked any
			if (lockedCommitments.length > 0) {
				const { getUtxoLockService } = await import(
					"./utxoLock"
				);
				const lockService = getUtxoLockService();
				lockService.unlock(lockedCommitments);
			}

			throw new TransactionError(
				ErrorCodes.ROOT_VERIFICATION_FAILED,
				"Merkle root changed during transaction preparation. This usually means the tree was updated by another transaction.",
				{ retryCount, maxRetries },
				err instanceof Error ? err : undefined
			);
		}

		// Check if this should be a delayed withdrawal
		if (delayMinutes && delayMinutes > 0) {
			// Submit delayed withdrawal
			setStatus?.(`(scheduling delayed withdrawal...)`);
			const delayedParams = {
				...withdrawParams,
				delayMinutes: delayMinutes,
			};

			const delayedResult =
				await submitDelayedWithdrawTorelayer(
					delayedParams,
				);

			// Unlock UTXOs if we locked any
			if (lockedCommitments.length > 0) {
				const { getUtxoLockService } = await import(
					"./utxoLock"
				);
				const lockService = getUtxoLockService();
				lockService.unlock(lockedCommitments);
			}

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
			const signature = await submitWithdrawTorelayer(
				withdrawParams,
			);
			log("Transaction signature:", signature);

			// Wait a moment for the transaction to be confirmed
			setStatus?.(
				`(waiting for transaction confirmation...)`,
			);

			// Check if UTXOs were added to the tree by polling the relayer
			// This ensures the change UTXO is indexed before we return
			try {
				const expectedNextIndex = currentNextIndex + 2;
				const maxPollingAttempts = 10;
				const pollingIntervalMs = 1000; // 1 second between attempts

				let attempts = 0;
				let treeStateMatches = false;

				while (attempts < maxPollingAttempts) {
					const updatedTreeState = await queryRemoteTreeState();

					if (updatedTreeState.nextIndex === expectedNextIndex) {
						log("Withdrawal complete. Change UTXO added to Merkle tree.");
						treeStateMatches = true;
						break;
					} else if (updatedTreeState.nextIndex > expectedNextIndex) {
						// Tree progressed beyond our expected index - our UTXOs are definitely in
						log(`Tree progressed beyond expected index (expected ${expectedNextIndex}, got ${updatedTreeState.nextIndex}). Change UTXO confirmed in tree.`);
						treeStateMatches = true;
						break;
					} else {
						// Tree hasn't caught up yet
						attempts++;
						if (attempts < maxPollingAttempts) {
							warn(`[SDK WARNING] Tree index mismatch: expected ${expectedNextIndex}, got ${updatedTreeState.nextIndex} - retrying (${attempts}/${maxPollingAttempts})...`);
							await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
						}
					}
				}

				if (!treeStateMatches) {
					const finalTreeState = await queryRemoteTreeState();
					warn(`[SDK WARNING] Tree index mismatch after ${maxPollingAttempts} attempts: expected ${expectedNextIndex}, got ${finalTreeState.nextIndex}. Change UTXO may not be immediately available.`);
				}
			} catch (err) {
				error("Failed to verify tree state after withdrawal:", err);
				warn(`[SDK WARNING] Could not verify change UTXO was indexed. Balance may not be immediately available.`);
			}

			// Unlock UTXOs if we locked any
			if (lockedCommitments.length > 0) {
				const { getUtxoLockService } = await import(
					"./utxoLock"
				);
				const lockService = getUtxoLockService();
				lockService.unlock(lockedCommitments);
			}

			// balance updating was removed here because it will updated after return true
			return { isPartial, success: true, signature };
		}
	} catch (err: any) {
		// Unlock UTXOs if we locked any (cleanup on error)
		if (lockedCommitments.length > 0) {
			const { getUtxoLockService } = await import(
				"./utxoLock"
			);
			const lockService = getUtxoLockService();
			lockService.unlock(lockedCommitments);
		}

		// Parse error to detect specific failure reasons
		const errorInfo = parseTransactionError(err);

		if (errorInfo.isRootMismatch) {
			error(
				" Root mismatch detected - tree was updated during transaction",
			);
			if (retryCount < maxRetries) {
				error(
					` Automatically retrying with updated root (attempt ${retryCount + 1}/${maxRetries})...`,
				);
				return await withdraw(
					recipient_address,
					amount_in_sol,
					signed,
					connection,
					setStatus,
					hasher,
					delayMinutes,
					maxRetries,
					retryCount + 1,
					utxoWalletSigned,
					utxoWalletSignTransaction,
				);
			}
		}

		if (errorInfo.isNullifierAlreadyUsed) {
			error(" UTXO already spent (nullifier already used)");
			throw new TransactionError(
				ErrorCodes.NULLIFIER_ALREADY_USED,
				"One or more UTXOs have already been spent. Please refresh your balance.",
				{ error: errorInfo.message }
			);
		}

		if (errorInfo.isInsufficientFunds) {
			error(" Insufficient funds for transaction");
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"Insufficient funds to complete the withdrawal. Check your balance and try again.",
				{ error: errorInfo.message }
			);
		}

		// Check if this is a NO_UNSPENT_UTXOS error (needs special handling with delay)
		const isNoUtxosError = err instanceof ValidationError && err.code === ErrorCodes.NO_UNSPENT_UTXOS;

		// General retry for other errors
		if (retryCount < maxRetries) {
			error(` Withdrawal failed:`, err);
			error(`Full error details: ${serializeError(err)}`);

			if (isNoUtxosError) {
				error(
					` No UTXOs available, retrying (attempt ${
						retryCount + 1
					}/${maxRetries})...`,
				);
			} else {
				error(
					` Retrying withdrawal (attempt ${
						retryCount + 1
					}/${maxRetries})...`,
				);
			}

			return await withdraw(
				recipient_address,
				amount_in_sol,
				signed,
				connection,
				setStatus,
				hasher,
				delayMinutes,
				maxRetries,
				retryCount + 1,
				utxoWalletSigned,
				utxoWalletSignTransaction,
			);
		}

		// Log full error before throwing
		error(` SOL Withdrawal failed after ${maxRetries} retries:`, err);
		error(`Full error details:\n${serializeError(err)}`);
		throw err;
	}
}
