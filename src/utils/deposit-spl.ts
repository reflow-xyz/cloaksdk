import {
	ComputeBudgetProgram,
	Connection,
	PublicKey,
	SystemProgram,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js";
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";
import { Keypair as UtxoKeypair } from "../models/keypair";
import { Utxo } from "../models/utxo";
import {
	ALT_ADDRESS,
	CIRCUIT_PATH,
	DEPOSIT_FEE_RATE,
	FEE_RECIPIENT,
	FIELD_SIZE,
	relayer_API_URL,
	MERKLE_TREE_DEPTH,
	PROGRAM_ID,
	TRANSACT_SPL_IX_DISCRIMINATOR,
} from "./constants";
import { EncryptionService, serializeProofAndExtData } from "./encryption";
import type { Signed } from "./getAccountSign";
import type { StatusCallback } from "../types/internal";
import { log, warn, error as error, serializeError } from "./logger";
import { fetchWithRetry } from "./fetchWithRetry";
import { Buffer } from "buffer";
import { useExistingALT } from "./address_lookup_table";
import { getExtDataHash } from "./getExtDataHash";
import { getMyUtxos, isUtxoSpent } from "./getMyUtxos";
import { MerkleTree } from "./merkle_tree";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover";
import { getGlobalConfigPDA, getUserTokenAccount } from "./spl-token-utils";
import {
	validateSplAmount,
	validatePublicKey,
	validateTransactionSize,
	parseTransactionError,
} from "./validation";
import { ErrorCodes, ValidationError, NetworkError, TransactionError, ConfigurationError } from '../errors';

/**
 * Query remote tree state from relayer API
 */
async function queryRemoteTreeState(): Promise<{
	root: string;
	nextIndex: number;
}> {
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
	return data;
}

/**
 * Fetch Merkle proof from API for a given commitment
 */
async function fetchMerkleProof(
	commitment: string,
): Promise<{ pathElements: string[]; pathIndices: number[] }> {
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
		};
		return data;
	} catch (err) {
		error(
			`Failed to fetch Merkle proof for commitment ${commitment}:`,
			err,
		);
		throw err;
	}
}

/**
 * Find nullifier PDAs for the given proof
 * nullifier2 and nullifier3 are cross-checks to prevent nullifier collision attacks
 */
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

	// Cross-check: nullifier0 seed with inputNullifiers[1]
	const [nullifier2PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier0"),
			Buffer.from(proof.inputNullifiers[1]),
		],
		PROGRAM_ID,
	);

	// Cross-check: nullifier1 seed with inputNullifiers[0]
	const [nullifier3PDA] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("nullifier1"),
			Buffer.from(proof.inputNullifiers[0]),
		],
		PROGRAM_ID,
	);

	return { nullifier0PDA, nullifier1PDA, nullifier2PDA, nullifier3PDA };
}

// Commitment PDAs were removed in contract commit 616f4bd

/**
 * Relay pre-signed SPL deposit transaction to relayer backend
 */
async function relaySplDepositTorelayer(
	signedTransaction: string,
): Promise<string> {
	try {
		const response = await fetchWithRetry(
			`${relayer_API_URL}/deposit/spl`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ signedTransaction }),
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
				`SPL deposit relay failed (${response.status}): ${errorMsg}`,
				{ endpoint: `${relayer_API_URL}/deposit/spl`, statusCode: response.status }
			);
		}

		const result = (await response.json()) as {
			signature: string;
			success: boolean;
		};

		return result.signature;
	} catch (err) {
		error(
			"Failed to relay SPL deposit transaction to relayer:",
			err,
		);
		throw err;
	}
}

/**
 * SPL Token Deposit Function
 *
 * @param amount - Amount of tokens to deposit (in base units, e.g., for USDC with 6 decimals: 1000000 = 1 USDC)
 * @param mintAddress - SPL token mint address (e.g., USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
 * @param signed - User's signed account information
 * @param connection - Solana connection
 * @param setStatus - Optional status update callback
 * @param hasher - Poseidon hasher instance
 * @returns Promise with success status and transaction signature
 */
export async function depositSpl(
	amount: number,
	mintAddress: string,
	signed: Signed,
	connection: Connection,
	setStatus?: StatusCallback,
	hasher?: any,
	signTransaction?: (
		tx: VersionedTransaction,
	) => Promise<VersionedTransaction>,
	maxRetries: number = 3,
	retryCount: number = 0,
	utxoWalletSigned?: Signed,
	utxoWalletSignTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
	relayerUrl: string = relayer_API_URL, // Relayer URL to use
	circuitPath: string = CIRCUIT_PATH, // Path to circuit files
): Promise<{ success: boolean; signature?: string }> {
	if (retryCount > 0) {
		log(`Retry attempt ${retryCount}/${maxRetries}`);
	}

	// Validate that if utxoWalletSigned is provided, utxoWalletSignTransaction must also be provided
	if (utxoWalletSigned && !utxoWalletSignTransaction) {
		throw new ValidationError(
			ErrorCodes.UTXO_WALLET_SIGN_TRANSACTION_REQUIRED,
			"utxoWalletSignTransaction callback is required when utxoWalletSigned is provided. " +
			"The UTXO wallet must be able to sign the deposit transaction."
		);
	}

	// Track locked commitments for cleanup
	let lockedCommitments: string[] = [];

	// Validate amount
	validateSplAmount(amount);

	try {
		let mint: PublicKey;
		let mintAddressNumeric: string;

		try {
			mint = new PublicKey(mintAddress);

			const mintBytes = mint.toBytes();
			const mintBN = new BN(mintBytes);
			mintAddressNumeric = mintBN.mod(FIELD_SIZE).toString();
		} catch (err: any) {
			error("Failed to convert mint address:", err);
			throw new ValidationError(
				ErrorCodes.INVALID_MINT_ADDRESS,
				`Failed to convert mint address: ${err.message}`,
				undefined,
				err instanceof Error ? err : undefined
			);
		}

		// Calculate deposit fee: DEPOSIT_FEE_RATE is in percentage (e.g., 0.3 means 0.3%)
		const fee_amount = Math.floor(
			(amount * DEPOSIT_FEE_RATE) / 100,
		);

		// Initialize hasher and encryption service
		let lightWasm = hasher;

		// Determine which wallet signature to use for UTXO derivation
		const utxoSignature = utxoWalletSigned ? utxoWalletSigned.signature : signed.signature;

		// Create encryption service for UTXO derivation (may use different wallet)
		const utxoEncryptionService = new EncryptionService();
		utxoEncryptionService.deriveEncryptionKeyFromSignature(utxoSignature);

		// Use UTXO wallet if provided, otherwise transaction wallet
		const walletToCheck = utxoWalletSigned || signed;

		// Get user's token account (from the wallet providing the tokens)
		const userTokenAccount = await getUserTokenAccount(
			walletToCheck.publicKey,
			mint,
		);

		// Check token balance
		try {
			const tokenBalance =
				await connection.getTokenAccountBalance(
					userTokenAccount,
				);
			const balance = Number(tokenBalance.value.amount);

			if (balance < amount + fee_amount) {
				throw new ValidationError(
					ErrorCodes.INSUFFICIENT_BALANCE,
					`Insufficient token balance: ${balance}. Need at least ${amount + fee_amount}.`
				);
			}
		} catch (err: any) {
			if (err.message.includes("could not find account")) {
				throw new ValidationError(
					ErrorCodes.INVALID_TOKEN_ACCOUNT,
					`Token account not found. You may not have any tokens of this type.`,
					undefined,
					err instanceof Error ? err : undefined
				);
			}
			throw err;
		}

		// Derive PDAs
		const [treeAccount] = PublicKey.findProgramAddressSync(
			[Buffer.from("merkle_tree")],
			PROGRAM_ID,
		);

		const globalConfigAccount = getGlobalConfigPDA();

		// Get tree's ATA for this token
		const treeAta = await getAssociatedTokenAddress(
			mint,
			globalConfigAccount,
			true, // allowOwnerOffCurve for PDA
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// Get fee recipient's ATA for this token
		const feeRecipientAta = await getAssociatedTokenAddress(
			mint,
			FEE_RECIPIENT,
			false,
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// For deposits, relayer fee recipient is not used (only for withdrawals)
		// Use fee recipient ATA as placeholder
		const relayerFeeRecipientAta = feeRecipientAta;

		// Create the merkle tree
		const tree = new MerkleTree(MERKLE_TREE_DEPTH, lightWasm);

		// Get tree state
		let root: string;
		let currentNextIndex: number;

		try {
			const data = await queryRemoteTreeState();
			root = data.root;
			currentNextIndex = data.nextIndex;
		} catch (err) {
			throw new NetworkError(
				ErrorCodes.API_FETCH_FAILED,
				"Failed to fetch Merkle tree state from relayer API. The relayer may be down or unreachable.",
				{ retryCount, maxRetries },
				err instanceof Error ? err : undefined
			);
		}

		// Generate UTXO keypair from the UTXO wallet
		const utxoPrivateKey = utxoEncryptionService.deriveUtxoPrivateKey();
		const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);

		// Fetch existing UTXOs for this mint (using UTXO wallet if provided)
		const allUtxos = await getMyUtxos(
			utxoWalletSigned || signed,
			connection,
			setStatus,
			hasher,
		);

		// Filter for this specific mint and non-zero amounts
		const mintUtxos = allUtxos.filter(
			(utxo) =>
				utxo.mintAddress === mintAddressNumeric &&
				utxo.amount.gt(new BN(0)),
		);

		// Check which UTXOs are unspent
		const utxoSpentStatuses = await Promise.all(
			mintUtxos.map((utxo) => isUtxoSpent(connection, utxo)),
		);

		const existingUnspentUtxos = mintUtxos.filter(
			(utxo, index) => !utxoSpentStatuses[index],
		);

		// Calculate output amounts
		let extAmount: number;
		let outputAmount: string;
		let inputs: Utxo[];
		let inputMerklePathIndices: number[];
		let inputMerklePathElements: string[][];

		if (existingUnspentUtxos.length === 0) {
			// Fresh deposit scenario
			extAmount = amount;
			outputAmount = new BN(amount)
				.sub(new BN(fee_amount))
				.toString();

			// Use dummy UTXOs as inputs with RANDOM keypairs to avoid nullifier collisions
			inputs = [
				new Utxo({
					lightWasm,
					// Don't specify keypair - let it generate a random one
					mintAddress: mintAddressNumeric,
				}),
				new Utxo({
					lightWasm,
					// Don't specify keypair - let it generate a random one
					mintAddress: mintAddressNumeric,
				}),
			];

			inputMerklePathIndices = inputs.map(
				(input) => input.index || 0,
			);
			inputMerklePathElements = inputs.map(() => {
				return [...new Array(tree.levels).fill("0")];
			});
		} else {
			// Consolidation scenario
			const firstUtxo = existingUnspentUtxos[0];
			const firstUtxoAmount = firstUtxo.amount;
			const secondUtxoAmount =
				existingUnspentUtxos.length > 1
					? existingUnspentUtxos[1].amount
					: new BN(0);
			extAmount = amount;

			outputAmount = firstUtxoAmount
				.add(secondUtxoAmount)
				.add(new BN(amount))
				.sub(new BN(fee_amount))
				.toString();

			const secondUtxo =
				existingUnspentUtxos.length > 1
					? existingUnspentUtxos[1]
					: new Utxo({
							lightWasm,
							// Don't specify keypair - use random to avoid nullifier collisions
							amount: new BN("0"),
							mintAddress:
								mintAddressNumeric,
					  });

			inputs = [firstUtxo, secondUtxo];

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
					fetchMerkleProof(firstUtxoCommitment),
					secondUtxoIsReal
						? secondUtxoCommitmentPromise.then(
								(commitment) =>
									commitment
										? fetchMerkleProof(
												commitment,
											)
										: null,
							)
						: Promise.resolve(null),
				]);

			inputMerklePathIndices = [
				firstUtxo.index || 0,
				secondUtxoIsReal && secondUtxoMerkleProof
					? secondUtxo.index || 0
					: 0,
			];

			inputMerklePathElements = [
				firstUtxoMerkleProof.pathElements,
				secondUtxoIsReal && secondUtxoMerkleProof
					? secondUtxoMerkleProof.pathElements
					: [...new Array(tree.levels).fill("0")],
			];
		}

		const publicAmountForCircuit = new BN(extAmount)
			.sub(new BN(fee_amount))
			.add(FIELD_SIZE)
			.mod(FIELD_SIZE);

		// Create output UTXOs with numeric mint address
		const outputs = [
			new Utxo({
				lightWasm,
				amount: outputAmount,
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

		// Generate nullifiers and commitments
		try {
			var inputNullifiers = await Promise.all(
				inputs.map((x) => x.getNullifier()),
			);

			var outputCommitments = await Promise.all(
				outputs.map((x) => x.getCommitment()),
			);
		} catch (commitmentErr: any) {
			throw new ValidationError(
				ErrorCodes.COMMITMENT_GENERATION_FAILED,
				`Failed to generate UTXO commitments: ${commitmentErr.message}`,
				undefined,
				commitmentErr instanceof Error ? commitmentErr : undefined
			);
		}

		// Encrypt UTXOs with UTXO wallet's encryption service
		const encryptedOutput1 = utxoEncryptionService.encryptUtxo(
			outputs[0],
		);
		const encryptedOutput2 = utxoEncryptionService.encryptUtxo(
			outputs[1],
		);

		// Create ExtData
		// Note: recipient and feeRecipient must be token accounts, not wallet addresses
		const extData = {
			recipient: userTokenAccount,
			extAmount: new BN(extAmount),
			encryptedOutput1: encryptedOutput1,
			encryptedOutput2: encryptedOutput2,
			fee: new BN(fee_amount),
			feeRecipient: feeRecipientAta, // Must be the ATA, not the wallet
			mintAddress: mint,
		};

		// Use PublicKey format to match on-chain TransactSpl calculation
		const calculatedExtDataHash = getExtDataHash(extData, false);

		// Create proof input
		const input = {
			root: root,
			inputNullifier: inputNullifiers,
			outputCommitment: outputCommitments,
			publicAmount: publicAmountForCircuit.toString(),
			extDataHash: calculatedExtDataHash,
			mintAddress: mintAddressNumeric,
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

		// Find nullifier PDAs (nullifier2/nullifier3 removed in latest contract)
		const [nullifier0PDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from("nullifier0"),
				Buffer.from(proofToSubmit.inputNullifiers[0]),
			],
			PROGRAM_ID,
		);

		const [nullifier1PDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from("nullifier1"),
				Buffer.from(proofToSubmit.inputNullifiers[1]),
			],
			PROGRAM_ID,
		);

		// Get Address Lookup Table
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

		// Compute budget
		const modifyComputeUnits =
			ComputeBudgetProgram.setComputeUnitLimit({
				units: 1_400_000,
			});

		// Create SPL deposit instruction
		// Account order must match TransactSpl in the smart contract
		// Determine which wallet to use for the deposit (the one providing funds)
		const depositWallet = utxoWalletSigned ? utxoWalletSigned.publicKey : signed.publicKey;

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
					pubkey: globalConfigAccount,
					isSigner: false,
					isWritable: false,
				},
				// signer - use UTXO wallet if provided
				{
					pubkey: depositWallet,
					isSigner: true,
					isWritable: true,
				},
				// recipient (not used in deposits) - use UTXO wallet if provided
				{
					pubkey: depositWallet,
					isSigner: false,
					isWritable: false,
				},
				// mint
				{
					pubkey: mint,
					isSigner: false,
					isWritable: false,
				},
				// signer_token_account
				{
					pubkey: userTokenAccount,
					isSigner: false,
					isWritable: true,
				},
				// recipient_token_account (not used in deposits, same as signer)
				{
					pubkey: userTokenAccount,
					isSigner: false,
					isWritable: true,
				},
				// tree_ata
				{
					pubkey: treeAta,
					isSigner: false,
					isWritable: true,
				},
				// fee_recipient_ata
				{
					pubkey: feeRecipientAta,
					isSigner: false,
					isWritable: true,
				},
				// relayer_fee_recipient_ata (not used in deposits, placeholder)
				{
					pubkey: relayerFeeRecipientAta,
					isSigner: false,
					isWritable: true,
				},
				// token_program (in ALT, will be referenced by index)
				{
					pubkey: TOKEN_PROGRAM_ID,
					isSigner: false,
					isWritable: false,
				},
				// associated_token_program (in ALT, will be referenced by index)
				{
					pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
					isSigner: false,
					isWritable: false,
				},
				// system_program (in ALT, will be referenced by index)
				{
					pubkey: SystemProgram.programId,
					isSigner: false,
					isWritable: false,
				},
			],
			programId: PROGRAM_ID,
			data: serializeProofAndExtData(
				proofToSubmit,
				extData,
				TRANSACT_SPL_IX_DISCRIMINATOR,
			),
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

		// Use the provided signTransaction function (required for SDK)
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

		// Check if root changed before submitting transaction
		try {
			const updatedData = await queryRemoteTreeState();
			if (updatedData.root !== root) {

				// Recursively call depositSpl again with updated state
				return await depositSpl(
					amount,
					mintAddress,
					signed,
					connection,
					setStatus,
					hasher,
					signTransaction,
					maxRetries,
					retryCount,
					utxoWalletSigned,
					utxoWalletSignTransaction,
				);
			}
		} catch (err) {
			throw new TransactionError(
				ErrorCodes.ROOT_VERIFICATION_FAILED,
				"Merkle root changed during transaction preparation. This usually means the tree was updated by another transaction.",
				{ retryCount, maxRetries },
				err instanceof Error ? err : undefined
			);
		}

		setStatus?.(`(submitting transaction to relayer...)`);
		const txid = await relaySplDepositTorelayer(
			Buffer.from(serializedTx).toString("base64"),
		);

		// Confirm transaction
		setStatus?.(`(waiting for transaction confirmation...)`);

		try {
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

				error(`Transaction failed on-chain. Full error details:\n${errorDetails}`);
				throw new TransactionError(
					ErrorCodes.TRANSACTION_FAILED,
					`Transaction failed on-chain: ${errorDetails}`,
					{ signature: txid, transactionLogs: errorDetails.split('\n') }
				);
			}
		} catch (confirmError) {
			error("Error confirming transaction:", confirmError);
		}

		return { success: true, signature: txid };
	} catch (err: any) {
		// Parse error to detect specific failure reasons
		const errorInfo = parseTransactionError(err);

		if (errorInfo.isRootMismatch) {
			if (retryCount < maxRetries) {
				log(
					`Retrying with updated root (attempt ${retryCount + 1}/${maxRetries})`,
				);
				return await depositSpl(
					amount,
					mintAddress,
					signed,
					connection,
					setStatus,
					hasher,
					signTransaction,
					maxRetries,
					retryCount + 1,
					utxoWalletSigned,
					utxoWalletSignTransaction,
				);
			}
		}

		if (errorInfo.isNullifierAlreadyUsed) {
			throw new TransactionError(
				ErrorCodes.NULLIFIER_ALREADY_USED,
				"One or more UTXOs have already been spent. Please refresh your balance.",
				{ error: errorInfo.message }
			);
		}

		if (errorInfo.isInsufficientFunds) {
			throw new ValidationError(
				ErrorCodes.INSUFFICIENT_BALANCE,
				"Insufficient funds to complete the SPL deposit. Check your balance and try again.",
				{ error: errorInfo.message }
			);
		}

		// General retry for other errors
		if (retryCount < maxRetries) {
			error(`SPL deposit failed:`, err);
			log(
				`Retrying SPL deposit (attempt ${
					retryCount + 1
				}/${maxRetries})`,
			);
			return await depositSpl(
				amount,
				mintAddress,
				signed,
				connection,
				setStatus,
				hasher,
				signTransaction,
				maxRetries,
				retryCount + 1,
				utxoWalletSigned,
				utxoWalletSignTransaction,
			);
		}

		// Log full error before throwing
		error(`SPL deposit failed after ${maxRetries} retries:`, err);
		throw err;
	}
}
