import {
	ComputeBudgetProgram,
	Connection,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";
import {
	ALT_ADDRESS,
	CIRCUIT_PATH,
	DEPLOYER_ID,
	DEPOSIT_FEE_RATE,
	FEE_RECIPIENT,
	FIELD_SIZE,
	relayer_API_URL,
	MERKLE_TREE_DEPTH,
	PROGRAM_ID,
	TRANSACT_IX_DISCRIMINATOR,
} from "./constants";
import { EncryptionService, serializeProofAndExtData } from "./encryption";
import type { Signed } from "./getAccountSign";
import type { StatusCallback } from "../types/internal";
import { log, warn, error as logError, serializeError } from "./logger";
import { fetchWithRetry } from "./fetchWithRetry";
import {
	validateDepositAmount,
	validateTransactionSize,
	parseTransactionError,
} from "./validation";
import { ErrorCodes, ValidationError, NetworkError, TransactionError, ConfigurationError } from '../errors';
import { withUtxoLocks } from "./utxoLock";

import { Buffer } from "buffer";
import { useExistingALT } from "./address_lookup_table";
import { getExtDataHash } from "./getExtDataHash";
import { getMyUtxos, isUtxoSpent } from "./getMyUtxos";
import { MerkleTree } from "./merkle_tree";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover";
// Function to query remote tree state from relayer API
async function queryRemoteTreeState(relayerUrl: string = relayer_API_URL): Promise<{
	root: string;
	nextIndex: number;
}> {
	const response = await fetchWithRetry(
		`${relayerUrl}/merkle/root`,
		undefined,
		3,
	);

	if (!response.ok) {
		throw new NetworkError(
			ErrorCodes.API_FETCH_FAILED,
			`Failed to fetch Merkle root and nextIndex: ${response.status} ${response.statusText}`,
			{ endpoint: `${relayerUrl}/merkle/root`, statusCode: response.status }
		);
	}

	const data = (await response.json()) as {
		root: string;
		nextIndex: number;
	};
	return data;
}

// Function to fetch Merkle proof from API for a given commitment
async function fetchMerkleProof(
	commitment: string,
	relayerUrl: string = relayer_API_URL,
): Promise<{ pathElements: string[]; pathIndices: number[]; index: number }> {
	const response = await fetchWithRetry(
		`${relayerUrl}/merkle/proof/${commitment}`,
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
		index: number;
	};
	return data;
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

	// nullifier2: seeds = [b"nullifier0", input_nullifiers[1]]
	const [nullifier2PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier0"),
			Buffer.from(proof.inputNullifiers[1]),
		],
		PROGRAM_ID,
	);

	// nullifier3: seeds = [b"nullifier1", input_nullifiers[0]]
	const [nullifier3PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier1"),
			Buffer.from(proof.inputNullifiers[0]),
		],
		PROGRAM_ID,
	);

	return { nullifier0PDA, nullifier1PDA, nullifier2PDA, nullifier3PDA };
}

export async function deposit(
	amount_in_sol: number,
	signed: Signed,
	connection: Connection,
	setStatus?: StatusCallback,
	hasher?: any,
	signTransaction?: (
		tx: VersionedTransaction,
	) => Promise<VersionedTransaction>,
	maxRetries: number = 3,
	retryCount: number = 0,
	utxoWalletSigned?: Signed, // Optional: different wallet's signature for UTXO keypair derivation
	utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>, // Optional: signing callback for UTXO wallet
	relayerUrl: string = relayer_API_URL, // Relayer URL to use
	circuitPath: string = CIRCUIT_PATH, // Path to circuit files
	transactionIndex?: number, // Index for batch deposits to create unique dummy UTXOs
	forceFreshDeposit?: boolean, // Force fresh deposit path (skip UTXO fetching) for batch deposits
	buildOnly?: boolean, // Only build the transaction, don't submit or confirm it
): Promise<{ success: boolean; signature?: string; transaction?: VersionedTransaction }> {
	// Validate that if utxoWalletSigned is provided, utxoWalletSignTransaction must also be provided
	if (utxoWalletSigned && !utxoWalletSignTransaction) {
		throw new ValidationError(
			ErrorCodes.UTXO_WALLET_SIGN_TRANSACTION_REQUIRED,
			"utxoWalletSignTransaction callback is required when utxoWalletSigned is provided. " +
			"The UTXO wallet must be able to sign the deposit transaction."
		);
	}

	const amount_in_lamports = amount_in_sol * LAMPORTS_PER_SOL;
	// Calculate fee: DEPOSIT_FEE_RATE is in percentage (e.g., 0.3 means 0.3%)
	const fee_amount_in_lamports = Math.floor(
		amount_in_lamports * (DEPOSIT_FEE_RATE / 100),
	);

	// Track locked commitments for cleanup
	let lockedCommitments: string[] = [];

	try {
		// Check wallet balance first - use UTXO wallet if provided, otherwise transaction wallet
		const walletToCheck = utxoWalletSigned || signed;
		const balance = await connection.getBalance(walletToCheck.publicKey);

		// Validate deposit amount with comprehensive checks
		try {
			validateDepositAmount(
				amount_in_sol,
				balance,
				fee_amount_in_lamports,
			);
		} catch (error) {
			if (error instanceof ValidationError) {
				logError(
					`❌ Validation failed: ${error.message}`,
				);
				throw error; // Re-throw to enable retry logic
			}
			throw error;
		}

		// Initialize the light protocol hasher
		let lightWasm = hasher;
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

		const [treeTokenAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("tree_token")],
			PROGRAM_ID,
		);
		const [globalConfigAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("global_config")],
			PROGRAM_ID,
		);

		// Create the merkle tree with the pre-initialized poseidon hash
		const tree = new MerkleTree(MERKLE_TREE_DEPTH, lightWasm);

		// Initialize root and nextIndex variables
		let root: string;
		let currentNextIndex: number;

		try {
			const data = await queryRemoteTreeState(relayerUrl);
			root = data.root;
			currentNextIndex = data.nextIndex;
		} catch (error) {
			logError("Failed to fetch Merkle tree state from API.");
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				"Failed to fetch Merkle tree state from relayer API. The relayer may be down or unreachable.",
				{ retryCount, maxRetries },
				error instanceof Error ? error : undefined
			);
		}

		// Determine which wallet signature to use for UTXO derivation
		const utxoSignature = utxoWalletSigned ? utxoWalletSigned.signature : signed.signature;

		// Create encryption service for UTXO derivation (may use different wallet)
		const utxoEncryptionService = new EncryptionService();
		utxoEncryptionService.deriveEncryptionKeyFromSignature(utxoSignature);

		// Generate a deterministic private key derived from the UTXO wallet keypair
		const utxoPrivateKey = utxoEncryptionService.deriveUtxoPrivateKey();

		// Create a UTXO keypair that will be used for all inputs and outputs
		const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

		// Fetch existing UTXOs for this UTXO wallet (may be different from transaction wallet)
		// Skip UTXO fetching for batch deposits to avoid locking conflicts
		let existingUnspentUtxos: Utxo[] = [];
		
		if (!forceFreshDeposit) {
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
			existingUnspentUtxos = solUtxos.filter(
				(utxo, index) => !utxoSpentStatuses[index],
			);
		}

		// Calculate output amounts and external amount based on scenario
		let extAmount: number;
		let outputAmount: string;

		// Create inputs based on whether we have existing UTXOs
		let inputs: Utxo[];
		let inputMerklePathIndices: number[];
		let inputMerklePathElements: string[][];

		if (existingUnspentUtxos.length === 0) {
			// Scenario 1: Fresh deposit with dummy inputs - add new funds to the system
			extAmount = amount_in_lamports;
			outputAmount = new BN(amount_in_lamports)
				.sub(new BN(fee_amount_in_lamports))
				.toString();

			// Validate transaction size before building proof
			validateTransactionSize({
				numInputs: 0, // Fresh deposit uses dummy inputs
				numOutputs: 2,
				hasProof: true,
				numAdditionalAccounts: 5,
			});

			// Use two dummy UTXOs as inputs with DETERMINISTIC keypairs for batch deposits
			// This ensures dummy input nullifiers can never collide across batch transactions

			// Create unique deterministic keypairs for batch deposits
			let dummyKeypair1: UtxoKeypair, dummyKeypair2: UtxoKeypair;
			let baseIndex: number;

			if (transactionIndex !== undefined) {
				// For batch deposits: derive deterministic keypairs from transaction index
				// Use a unique seed for each dummy UTXO: combine timestamp with transaction index
				const timestamp = Date.now();
				const seed1 = `dummy_utxo_${timestamp}_${transactionIndex}_0`;
				const seed2 = `dummy_utxo_${timestamp}_${transactionIndex}_1`;

				// Create deterministic private keys from seeds
				const encoder = new TextEncoder();
				const seedBytes1 = encoder.encode(seed1);
				const seedBytes2 = encoder.encode(seed2);

				// Hash the seeds to create private keys
				// Convert seed bytes to a hex string and take first 64 chars for private key
				const privkey1 = BigInt('0x' + Array.from(seedBytes1).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64));
				const privkey2 = BigInt('0x' + Array.from(seedBytes2).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64));

				dummyKeypair1 = new UtxoKeypair(privkey1.toString(), lightWasm);
				dummyKeypair2 = new UtxoKeypair(privkey2.toString(), lightWasm);

				// Use unique indices for each transaction in the batch
				baseIndex = transactionIndex * 2;
			} else {
				// For single deposits: use random keypairs (no collision risk)
				dummyKeypair1 = await UtxoKeypair.generateNew(lightWasm);
				dummyKeypair2 = await UtxoKeypair.generateNew(lightWasm);
				baseIndex = 0;
			}

			inputs = [
				new Utxo({
					lightWasm,
					keypair: dummyKeypair1,
					index: baseIndex,
					amount: 0,
				}),
				new Utxo({
					lightWasm,
					keypair: dummyKeypair2,
					index: baseIndex + 1,
					amount: 0,
				}),
			];

			// Both inputs are dummy, so use mock indices and zero-filled Merkle paths
			inputMerklePathIndices = inputs.map(
				(input) => input.index || 0,
			);
			inputMerklePathElements = inputs.map(() => {
				return [...new Array(tree.levels).fill("0")];
			});
		} else {
			// Scenario 2: Deposit that consolidates with existing UTXO

			// Lock the UTXOs we're about to use to prevent concurrent operations
			const utxosToLock = existingUnspentUtxos.slice(0, 2);
			lockedCommitments = await Promise.all(
				utxosToLock.map((u) => u.getCommitment()),
			);

			const { getUtxoLockService } = await import(
				"./utxoLock"
			);
			const lockService = getUtxoLockService();
			const locked = await lockService.tryLockWithRetry(
				lockedCommitments,
				"deposit-consolidation",
				3,
				1000,
			);

			if (!locked) {
				throw new ValidationError(
					ErrorCodes.INVALID_STATE,
					"Could not acquire locks on UTXOs. They may be in use by another operation."
				);
			}

			const firstUtxo = existingUnspentUtxos[0];
			const firstUtxoAmount = firstUtxo.amount;
			const secondUtxoAmount =
				existingUnspentUtxos.length > 1
					? existingUnspentUtxos[1].amount
					: new BN(0);
			extAmount = amount_in_lamports; // Still depositing new funds

			// Output combines existing UTXO amount + new deposit amount - fee
			outputAmount = firstUtxoAmount
				.add(secondUtxoAmount)
				.add(new BN(amount_in_lamports))
				.sub(new BN(fee_amount_in_lamports))
				.toString();

			// Validate transaction size before building proof
			const numInputs =
				existingUnspentUtxos.length > 0
					? secondUtxoAmount.gt(new BN(0))
						? 2
						: 1
					: 0;
			validateTransactionSize({
				numInputs,
				numOutputs: 2,
				hasProof: true,
				numAdditionalAccounts: 5,
			});

			// Use first existing UTXO as first input, dummy UTXO as second input
			// const secondUtxo = existingUnspentUtxos.length > 1 ? existingUnspentUtxos[1] : new Utxo({
			//     lightWasm,
			//     keypair: await UtxoKeypair.generateNew(lightWasm),
			//     amount: new BN('0')
			// });

			// Use first existing UTXO as first input, dummy UTXO as second input
			const secondUtxo =
				existingUnspentUtxos.length > 1
					? existingUnspentUtxos[1]
					: new Utxo({
							lightWasm,
							// Don't specify keypair - use random to avoid nullifier collisions
							amount: new BN("0"),
					  });

			inputs = [
				firstUtxo, // Use the first existing UTXO
				secondUtxo, // Use second UTXO if available, otherwise dummy
			];

			// Parallelize Merkle proof fetching for both UTXOs
			const firstUtxoCommitment =
				await firstUtxo.getCommitment();

			// Check if second UTXO is real and needs a proof
			const secondUtxoIsReal = secondUtxo.amount.gt(new BN(0));
			const secondUtxoCommitmentPromise = secondUtxoIsReal
				? secondUtxo.getCommitment()
				: Promise.resolve(null);

			// Fetch both Merkle proofs in parallel
			const [firstUtxoMerkleProof, secondUtxoMerkleProof] =
				await Promise.all([
					fetchMerkleProof(firstUtxoCommitment, relayerUrl),
					secondUtxoIsReal
						? secondUtxoCommitmentPromise.then(
								(commitment) =>
									commitment
										? fetchMerkleProof(
												commitment,
												relayerUrl,
											)
										: null,
							)
						: Promise.resolve(null),
				]);

			// Update UTXO index with correct value from tree BEFORE calculating nullifiers
			firstUtxo.index = firstUtxoMerkleProof.index;

			// Use the actual tree indices from the relayer
			// inPathIndices in circuit expects the UTXO's position in tree, not the path directions
			inputMerklePathIndices = [
				firstUtxoMerkleProof.index,
				secondUtxoIsReal && secondUtxoMerkleProof
					? secondUtxoMerkleProof.index
					: 0,
			];

			if (secondUtxoIsReal && secondUtxoMerkleProof) {
				// Update second UTXO index with correct value from tree
				secondUtxo.index = secondUtxoMerkleProof.index;
			}

			// Create Merkle path elements: real proof for first input, zeros for second input
			inputMerklePathElements = [
				firstUtxoMerkleProof.pathElements, // Real Merkle proof for first existing UTXO
				secondUtxo.amount.gt(new BN(0))
					? secondUtxoMerkleProof!.pathElements
					: [...new Array(tree.levels).fill("0")], // Real proof or zero-filled for dummy
			];

			log(
				`Using first UTXO with amount: ${firstUtxo.amount.toString()} and index: ${
					firstUtxo.index
				}`,
			);
			log(
				`Using second ${
					secondUtxo.amount.gt(new BN(0))
						? "UTXO"
						: "dummy UTXO"
				} with amount: ${secondUtxo.amount.toString()}${
					secondUtxo.amount.gt(new BN(0))
						? ` and index: ${secondUtxo.index}`
						: ""
				}`,
			);
			log(
				`First UTXO Merkle proof path indices from API: [${firstUtxoMerkleProof.pathIndices.join(
					", ",
				)}]`,
			);
			if (secondUtxo.amount.gt(new BN(0))) {
				log(
					`Second UTXO Merkle proof path indices from API: [${secondUtxoMerkleProof!.pathIndices.join(
						", ",
					)}]`,
				);
			}
		}

		const publicAmountForCircuit = new BN(extAmount)
			.sub(new BN(fee_amount_in_lamports))
			.add(FIELD_SIZE)
			.mod(FIELD_SIZE);

		// Create outputs for the transaction with the same shared keypair
		const outputs = [
			new Utxo({
				lightWasm,
				amount: outputAmount,
				keypair: utxoKeypair,
				index: currentNextIndex, // This UTXO will be inserted at currentNextIndex
			}), // Output with value (either deposit amount minus fee, or input amount minus fee)
			new Utxo({
				lightWasm,
				amount: new BN("0"),
				keypair: utxoKeypair,
				index: currentNextIndex + 1, // This UTXO will be inserted at currentNextIndex + 1
			}), // Empty UTXO
		];

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

		// Create the deposit ExtData with real encrypted outputs
		// Use UTXO wallet as recipient if provided, otherwise use transaction wallet
		const extDataRecipient = utxoWalletSigned ? utxoWalletSigned.publicKey : signed.publicKey;

		const extData = {
			recipient: extDataRecipient,
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
			inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
			outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
			publicAmount: publicAmountForCircuit.toString(), // Use proper field arithmetic result
			extDataHash: calculatedExtDataHash,

			// Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
			inAmount: inputs.map((x) => x.amount.toString(10)),
			inPrivateKey: inputs.map((x) => x.keypair.privkey),
			inBlinding: inputs.map((x) => x.blinding.toString(10)),
			inPathIndices: inputMerklePathIndices,
			inPathElements: inputMerklePathElements,

			// Output UTXO data (UTXOs being created) - ensure all values are in decimal format
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
		const {
			nullifier0PDA,
			nullifier1PDA,
			nullifier2PDA,
			nullifier3PDA,
		} = findNullifierPDAs(proofToSubmit);

		// Address Lookup Table for transaction size optimization
		const lookupTableAccount = await useExistingALT(
			connection,
			ALT_ADDRESS,
		);

		if (!lookupTableAccount?.value) {
			throw new ConfigurationError(
				ErrorCodes.INVALID_CONFIGURATION,
				`ALT not found at address ${ALT_ADDRESS.toString()}`
			);
		}

		// Set compute budget for the transaction (needed for complex transactions)
		const modifyComputeUnits =
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_000_000,
			});

		// Determine which wallet to use for the deposit (the one providing funds)
		const depositWallet = utxoWalletSigned ? utxoWalletSigned.publicKey : signed.publicKey;

		// Create the transaction instruction
		const instruction = new TransactionInstruction({
			keys: [
				{
					pubkey: treeAccount,
					isSigner: false,
					isWritable: true,
				},
				{
					pubkey: nullifier0PDA,
					isSigner: false,
					isWritable: true,
				},
				{
					pubkey: nullifier1PDA,
					isSigner: false,
					isWritable: true,
				},
				{
					pubkey: nullifier2PDA,
					isSigner: false,
					isWritable: false,
				},
				{
					pubkey: nullifier3PDA,
					isSigner: false,
					isWritable: false,
				},
				{
					pubkey: treeTokenAccount,
					isSigner: false,
					isWritable: true,
				},
				{
					pubkey: globalConfigAccount,
					isSigner: false,
					isWritable: false,
				},
				// recipient - use UTXO wallet if provided
				{
					pubkey: depositWallet,
					isSigner: false,
					isWritable: true,
				},
				// fee recipient
				{
					pubkey: FEE_RECIPIENT,
					isSigner: false,
					isWritable: true,
				},
				// signer - use UTXO wallet if provided
				{
					pubkey: depositWallet,
					isSigner: true,
					isWritable: true,
				},
				{
					pubkey: SystemProgram.programId,
					isSigner: false,
					isWritable: false,
				},
			],
			programId: PROGRAM_ID,
			data: serializeProofAndExtData(proofToSubmit, extData),
		});
		const recentBlockhash = await connection.getLatestBlockhash();

		// Use UTXO wallet as payer if provided (since it has the funds), otherwise use transaction wallet
		const payerKey = utxoWalletSigned ? utxoWalletSigned.publicKey : signed.publicKey;

		const messageV0 = new TransactionMessage({
			payerKey: payerKey,
			recentBlockhash: recentBlockhash.blockhash,
			instructions: [modifyComputeUnits, instruction],
		}).compileToV0Message([lookupTableAccount.value]);

		const transaction = new VersionedTransaction(messageV0);

		// Sign the transaction using the provided signTransaction function
		let txid;

		// Use the UTXO wallet's signing callback if provided, otherwise use default
		let signedTx: VersionedTransaction;
		const signingCallback = utxoWalletSignTransaction || signTransaction;

		if (!signingCallback) {
			throw new ConfigurationError(
				ErrorCodes.SIGN_TRANSACTION_REQUIRED,
				"signTransaction function is required"
			);
		}

		signedTx = await signingCallback(transaction);
		const serializedTx = signedTx.serialize();

		// If buildOnly is true, return the signed transaction without submitting
		if (buildOnly) {
			log("Build-only mode: returning signed transaction without submission");
			return { 
				success: true, 
				transaction: signedTx,
				signature: undefined 
			};
		}

		// Check if root changed before submitting transaction
		try {
			const updatedData = await queryRemoteTreeState(relayerUrl);
			if (updatedData.root !== root) {
				logError("Merkle root changed before transaction submission. Retrying with updated state.");

				// Recursively call deposit again with updated state
				return await deposit(
					amount_in_sol,
					signed,
					connection,
					setStatus,
					hasher,
					signTransaction,
					maxRetries,
					retryCount,
					utxoWalletSigned,
					utxoWalletSignTransaction,
					relayerUrl,
					circuitPath,
					transactionIndex,
					forceFreshDeposit,
					buildOnly,
				);
			}
		} catch (error) {
			logError("Failed to verify Merkle root before submission.");
			throw new TransactionError(
				ErrorCodes.ROOT_VERIFICATION_FAILED,
				"Merkle root changed during transaction preparation. This usually means the tree was updated by another transaction.",
				{ retryCount, maxRetries },
				error instanceof Error ? error : undefined
			);
		}

		setStatus?.(`(submitting transaction to relayer...)`);
		txid = await relayDepositTorelayer(
			Buffer.from(serializedTx).toString("base64"),
		);

		log("Deposit transaction initiated:", txid);

		// Properly confirm the transaction
		setStatus?.(`(waiting for transaction confirmation...)`);

		try {
			// Wait for transaction confirmation
			const latestBlockhash =
				await connection.getLatestBlockhash();
			const confirmationResult =
				await connection.confirmTransaction(
					{
						signature: txid,
						blockhash: latestBlockhash.blockhash,
						lastValidBlockHeight:
							latestBlockhash.lastValidBlockHeight,
					},
					"confirmed",
				);

			if (confirmationResult.value.err) {
				const err = confirmationResult.value.err;
				// Extract all error details from Solana transaction error
				let errorDetails = '';

				if (typeof err === 'object' && err !== null) {
					// Try to extract InstructionError details
					if ('InstructionError' in err) {
						const [idx, instructionErr] = (err as any).InstructionError;
						errorDetails = `InstructionError at index ${idx}: ${JSON.stringify(instructionErr, null, 2)}`;
					} else {
						// For other error types, try to get all properties
						try {
							errorDetails = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
						} catch {
							errorDetails = String(err);
						}
					}
				} else {
					errorDetails = String(err);
				}

				logError(`Transaction failed on-chain. Full error details:\n${errorDetails}`);
				throw new TransactionError(
					ErrorCodes.TRANSACTION_FAILED,
					`Transaction failed on-chain: ${errorDetails}`,
					{ signature: txid, transactionLogs: errorDetails.split('\n') }
				);
			}

			log("Deposit transaction confirmed.");
		} catch (confirmError) {
			logError("Error confirming transaction:", confirmError);
			// Still continue as the transaction might have succeeded
		}

		// Check if UTXOs were added to the tree by fetching the tree account again
		// Poll until tree state matches expected value or timeout
		try {
			const expectedNextIndex = currentNextIndex + 2;
			const maxPollingAttempts = 10;
			const pollingIntervalMs = 1000; // 1 second between attempts

			let attempts = 0;
			let treeStateMatches = false;

			while (attempts < maxPollingAttempts) {
				const updatedTreeState = await queryRemoteTreeState(relayerUrl);

				if (updatedTreeState.nextIndex === expectedNextIndex) {
					log("Deposit complete. UTXOs added to Merkle tree.");
					treeStateMatches = true;
					break;
				} else if (updatedTreeState.nextIndex > expectedNextIndex) {
					// Tree progressed beyond our expected index - our UTXOs are definitely in
					log(`Tree progressed beyond expected index (expected ${expectedNextIndex}, got ${updatedTreeState.nextIndex}). UTXOs confirmed in tree.`);
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
				const finalTreeState = await queryRemoteTreeState(relayerUrl);
				warn(`[SDK WARNING] Tree index mismatch after ${maxPollingAttempts} attempts: expected ${expectedNextIndex}, got ${finalTreeState.nextIndex}`);
			}

			// Unlock UTXOs if we locked any
			if (lockedCommitments.length > 0) {
				const { getUtxoLockService } =
					await import("./utxoLock");
				const lockService =
					getUtxoLockService();
				lockService.unlock(lockedCommitments);
			}

			return { success: true, signature: txid };
		} catch (error) {
			logError("Failed to fetch tree state after deposit:", error);

			// Unlock UTXOs if we locked any
			if (lockedCommitments.length > 0) {
				const { getUtxoLockService } = await import(
					"./utxoLock"
				);
				const lockService = getUtxoLockService();
				lockService.unlock(lockedCommitments);
			}

			// Even if we can't verify the tree state, the transaction was sent successfully
			return { success: true, signature: txid };
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
			logError("Root mismatch detected. Merkle tree was updated during transaction.");
			if (retryCount < maxRetries) {
				logError(`Retrying with updated root (attempt ${retryCount + 1}/${maxRetries}).`);
				return await deposit(
					amount_in_sol,
					signed,
					connection,
					setStatus,
					hasher,
					signTransaction,
					maxRetries,
					retryCount + 1,
					utxoWalletSigned,
					utxoWalletSignTransaction,
					relayerUrl,
					circuitPath,
					transactionIndex,
					forceFreshDeposit,
					buildOnly,
				);
			}
		}

		if (errorInfo.isNullifierAlreadyUsed) {
			logError("UTXO already spent (nullifier already used).");
			throw new TransactionError(
				ErrorCodes.NULLIFIER_ALREADY_USED,
				"One or more UTXOs have already been spent. Please refresh your balance.",
				{ error: errorInfo.message }
			);
		}

		if (errorInfo.isInsufficientFunds) {
			logError("Insufficient funds for transaction.");
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"Insufficient funds to complete the deposit. Check your balance and try again.",
				{ error: errorInfo.message }
			);
		}

		// General retry for other errors
		if (retryCount < maxRetries) {
			logError(`Deposit failed:`, err);
			logError(`Full error details: ${serializeError(err)}`);
			logError(`Retrying deposit (attempt ${retryCount + 1}/${maxRetries}).`);
			return await deposit(
				amount_in_sol,
				signed,
				connection,
				setStatus,
				hasher,
				signTransaction,
				maxRetries,
				retryCount + 1,
				utxoWalletSigned,
				utxoWalletSignTransaction,
				relayerUrl,
				circuitPath,
				transactionIndex,
				forceFreshDeposit,
				buildOnly,
			);
		}

		// Log full error before throwing
		logError(`SOL deposit failed after ${maxRetries} retries:`, err);
		logError(`Full error details:\n${serializeError(err)}`);
		throw err;
	}
}

export async function checkDepositLimit(connection: Connection) {
	try {
		// Derive the tree account PDA
		const [treeAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("merkle_tree")],
			PROGRAM_ID,
		);

		// Fetch the account data
		const accountInfo = await connection.getAccountInfo(
			treeAccount,
		);

		if (!accountInfo) {
			logError("Tree account not found. Make sure the program is initialized.");
			return;
		}
		const maxDepositAmount = new BN(
			Buffer.from(accountInfo.data.slice(4120, 4128)),
			"le",
		);

		// Convert to SOL using BN division to handle large numbers
		const lamportsPerSol = new BN(1_000_000_000);
		const maxDepositSol = maxDepositAmount.div(lamportsPerSol);
		const remainder = maxDepositAmount.mod(lamportsPerSol);

		// Format the SOL amount with decimals
		let solFormatted = "1";
		if (remainder.eq(new BN(0))) {
			solFormatted = maxDepositSol.toString();
		} else {
			// Handle fractional SOL by converting remainder to decimal
			const fractional = remainder.toNumber() / 1e9;
			solFormatted = `${maxDepositSol.toString()}${fractional
				.toFixed(9)
				.substring(1)}`;
		}
		return Number(solFormatted);
	} catch (error) {
		logError("Error reading deposit limit:", error);
		throw error;
	}
}

// Function to relay pre-signed deposit transaction to relayer backend
async function relayDepositTorelayer(
	signedTransaction: string,
): Promise<string> {
	try {
		const params = {
			signedTransaction,
		};

		const response = await fetchWithRetry(
			`${relayer_API_URL}/deposit`,
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
				`Deposit relay failed (${response.status}): ${errorMsg}`,
				{ endpoint: `${relayer_API_URL}/deposit`, statusCode: response.status }
			);
		}

		const result = (await response.json()) as {
			signature: string;
			success: boolean;
		};

		return result.signature;
	} catch (error) {
		logError(
			"Failed to relay deposit transaction to relayer:",
			error,
		);
		throw error;
	}
}
