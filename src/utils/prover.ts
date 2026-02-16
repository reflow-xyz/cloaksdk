import { error as error } from "./logger";

import BN from "bn.js";

import { groth16 } from "snarkjs";
import { FIELD_SIZE } from "./constants";

import { utils } from "ffjavascript";

type Groth16Module = {
	fullProve: (
		input: unknown,
		wasmFile: string,
		zkeyFile: string,
	) => Promise<{ proof: Proof; publicSignals: string[] }>;
	verify: (
		vkeyData: unknown,
		publicSignals: unknown,
		proof: Proof,
	) => Promise<boolean>;
};

type UtilsModule = {
	stringifyBigInts: (obj: unknown) => unknown;
	unstringifyBigInts: (obj: unknown) => unknown;
};

// Cast imported modules to their types
const groth16Typed = groth16 as unknown as Groth16Module;
const utilsTyped = utils as unknown as UtilsModule;

// Define interfaces for the proof structures
interface Proof {
	pi_a: string[];
	pi_b: string[][];
	pi_c: string[];
	protocol: string;
	curve: string;
}

/**
 * Generates a ZK proof using snarkjs and formats it for use on-chain
 *
 * @param input The circuit inputs to generate a proof for
 * @param keyBasePath The base path for the circuit keys (.wasm and .zkey files)
 * @returns A proof object with formatted proof elements and public signals
 */
async function prove(
	input: unknown,
	keyBasePath: string,
): Promise<{
	proof: Proof;
	publicSignals: string[];
}> {
	try {
		const wasmPath = `${keyBasePath}.wasm`;
		const zkeyPath = `${keyBasePath}.zkey`;

		const circuitInput = utilsTyped.stringifyBigInts(input);

		const { proof, publicSignals } = await groth16Typed.fullProve(
			circuitInput,
			wasmPath,
			zkeyPath,
		);

		return { proof, publicSignals };
	} catch (err: unknown) {
		const errMessage =
			err instanceof Error ? err.message : String(err);
		error("Proof generation failed:", errMessage);

		// Parse the error to provide context
		if (errMessage) {
			const errorMsg = errMessage;

			// Extract template name and instance
			const templateMatch = errorMsg.match(
				/Error in template (\w+)_(\d+)/,
			);
			if (templateMatch) {
				error(
					`Failed in template: ${templateMatch[1]} (instance ${templateMatch[2]})`,
				);
			}

			// Extract line number
			const lineMatch = errorMsg.match(/line: (\d+)/);
			if (lineMatch) {
				error(`Circuit line: ${lineMatch[1]}`);
			}

			// Check for specific error types
			if (errorMsg.includes("ForceEqualIfEnabled")) {
				error(
					"Merkle proof verification failed. Root mismatch - check path indices and tree state.",
				);
			} else if (errorMsg.includes("IsEqual")) {
				error(
					"Equality check failed in circuit",
				);
			} else if (
				errorMsg.includes("sumIns") ||
				errorMsg.includes("sumOuts")
			) {
				error("Balance equation failed: sumIns + publicAmount !== sumOuts");
			}
		}
		throw err;
	}
}

export function parseProofToBytesArray(
	proof: Proof,
	compressed: boolean = false,
): {
	proofA: number[];
	proofB: number[][];
	proofC: number[];
} {
	const proofJson = JSON.stringify(proof, null, 1);
	const mydata = JSON.parse(proofJson.toString());
	try {
		for (const i in mydata) {
			if (i == "pi_a" || i == "pi_c") {
				for (const j in mydata[i]) {
					mydata[i][j] = Array.from(
						utils.leInt2Buff(
							utils.unstringifyBigInts(
								mydata[i][j],
							),
							32,
						),
					).reverse();
				}
			} else if (i == "pi_b") {
				for (const j in mydata[i]) {
					for (const z in mydata[i][j]) {
						mydata[i][j][z] = Array.from(
							utils.leInt2Buff(
								utils.unstringifyBigInts(
									mydata[
										i
									][j][z],
								),
								32,
							),
						);
					}
				}
			}
		}

		if (compressed) {
			const proofA = mydata.pi_a[0];
			// negate proof by reversing the bitmask
			const proofAIsPositive = yElementIsPositiveG1(
				new BN(mydata.pi_a[1]),
			)
				? false
				: true;
			proofA[0] = addBitmaskToByte(
				proofA[0],
				proofAIsPositive,
			);
			const proofB = mydata.pi_b[0].flat().reverse();
			const proofBY = mydata.pi_b[1].flat().reverse();
			const proofBIsPositive = yElementIsPositiveG2(
				new BN(proofBY.slice(0, 32)),
				new BN(proofBY.slice(32, 64)),
			);
			proofB[0] = addBitmaskToByte(
				proofB[0],
				proofBIsPositive,
			);
			const proofC = mydata.pi_c[0];
			const proofCIsPositive = yElementIsPositiveG1(
				new BN(mydata.pi_c[1]),
			);
			proofC[0] = addBitmaskToByte(
				proofC[0],
				proofCIsPositive,
			);
			return {
				proofA,
				proofB,
				proofC,
			};
		}
		return {
			proofA: [mydata.pi_a[0], mydata.pi_a[1]].flat(),
			proofB: [
				mydata.pi_b[0].flat().reverse(),
				mydata.pi_b[1].flat().reverse(),
			].flat(),
			proofC: [mydata.pi_c[0], mydata.pi_c[1]].flat(),
		};
	} catch (err: unknown) {
		error(
			"Error while parsing the proof.",
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}

// mainly used to parse the public signals of groth16 fullProve
export function parseToBytesArray(publicSignals: string[]): number[][] {
	const publicInputsJson = JSON.stringify(publicSignals, null, 1);
	const publicInputsBytesJson = JSON.parse(publicInputsJson.toString());
	try {
		const publicInputsBytes = new Array<Array<number>>();
		for (const i in publicInputsBytesJson) {
			const ref: Array<number> = Array.from([
				...utils.leInt2Buff(
					utils.unstringifyBigInts(
						publicInputsBytesJson[i],
					),
					32,
				),
			]).reverse();
			publicInputsBytes.push(ref);
		}

		return publicInputsBytes;
	} catch (err: unknown) {
		error(
			"Error while parsing public inputs.",
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}

function yElementIsPositiveG1(yElement: BN): boolean {
	return yElement.lte(FIELD_SIZE.sub(yElement));
}

function yElementIsPositiveG2(yElement1: BN, yElement2: BN): boolean {
	const fieldMidpoint = FIELD_SIZE.div(new BN(2));

	// Compare the first component of the y coordinate
	if (yElement1.lt(fieldMidpoint)) {
		return true;
	} else if (yElement1.gt(fieldMidpoint)) {
		return false;
	}

	// If the first component is equal to the midpoint, compare the second component
	return yElement2.lt(fieldMidpoint);
}

// bitmask compatible with solana altbn128 compression syscall and arkworks' implementation
// https://github.com/arkworks-rs/algebra/blob/master/ff/src/fields/models/fp/mod.rs#L580
// https://github.com/arkworks-rs/algebra/blob/master/serialize/src/flags.rs#L18
// fn u8_bitmask(value: u8, inf: bool, neg: bool) -> u8 {
//     let mut mask = 0;
//     match self {
//         inf => mask |= 1 << 6,
//         neg => mask |= 1 << 7,
//         _ => (),
//     }
//     mask
// }
function addBitmaskToByte(byte: number, yIsPositive: boolean): number {
	if (!yIsPositive) {
		return (byte |= 1 << 7);
	} else {
		return byte;
	}
}

export { prove, type Proof };
