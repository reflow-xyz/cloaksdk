declare module "snarkjs" {
	export const groth16: {
		fullProve: (
			input: unknown,
			wasmFile: string,
			zkeyFile: string,
		) => Promise<{ proof: unknown; publicSignals: string[] }>;
		verify: (
			vkeyData: unknown,
			publicSignals: unknown,
			proof: unknown,
		) => Promise<boolean>;
	};
}

declare module "ffjavascript" {
	export const utils: {
		stringifyBigInts: (obj: unknown) => unknown;
		unstringifyBigInts: (obj: unknown) => unknown;
		leInt2Buff: (value: unknown, size: number) => Uint8Array;
	};
}
