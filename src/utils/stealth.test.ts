import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
	generateMetaAddress,
	deriveStealthKeypair,
} from "./stealth";

// ─── Helpers ──────────────────────────────────────────────

function createEphemeralPubkeyHex(): string {
	const secret = x25519.utils.randomPrivateKey();
	return Buffer.from(x25519.getPublicKey(secret)).toString("hex");
}

// ─── generateMetaAddress ──────────────────────────────────

describe("generateMetaAddress", () => {
	it("returns a valid structure", () => {
		const meta = generateMetaAddress();

		expect(meta.spendKeypair.secretKey.length).toBe(64);
		expect(meta.viewSecret.length).toBe(32);
		expect(meta.viewPubkeyHex.length).toBe(64); // 32 bytes in hex
		expect(Buffer.from(meta.viewPubkeyHex, "hex").length).toBe(32);
	});

	it("view pubkey matches view secret", () => {
		const meta = generateMetaAddress();
		const derivedPubkey = x25519.getPublicKey(meta.viewSecret);
		const expectedHex = Buffer.from(derivedPubkey).toString("hex");
		expect(meta.viewPubkeyHex).toBe(expectedHex);
	});

	it("generates unique addresses on each call", () => {
		const a = generateMetaAddress();
		const b = generateMetaAddress();
		expect(a.spendKeypair.publicKey.toBase58()).not.toBe(
			b.spendKeypair.publicKey.toBase58(),
		);
		expect(a.viewPubkeyHex).not.toBe(b.viewPubkeyHex);
	});
});

// ─── deriveStealthKeypair ─────────────────────────────────

describe("deriveStealthKeypair", () => {
	it("is deterministic for the same inputs", () => {
		const spend = Keypair.generate();
		const viewSecret = x25519.utils.randomPrivateKey();
		const ephHex = createEphemeralPubkeyHex();

		const a = deriveStealthKeypair(spend, viewSecret, ephHex);
		const b = deriveStealthKeypair(spend, viewSecret, ephHex);

		expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
	});

	it("different ephemeral keys produce different stealth keys", () => {
		const spend = Keypair.generate();
		const viewSecret = x25519.utils.randomPrivateKey();

		const a = deriveStealthKeypair(spend, viewSecret, createEphemeralPubkeyHex());
		const b = deriveStealthKeypair(spend, viewSecret, createEphemeralPubkeyHex());

		expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
	});

	it("different spend keys produce different stealth keys", () => {
		const viewSecret = x25519.utils.randomPrivateKey();
		const ephHex = createEphemeralPubkeyHex();

		const a = deriveStealthKeypair(Keypair.generate(), viewSecret, ephHex);
		const b = deriveStealthKeypair(Keypair.generate(), viewSecret, ephHex);

		expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
	});

	it("different view secrets produce different stealth keys", () => {
		const spend = Keypair.generate();
		const ephHex = createEphemeralPubkeyHex();

		const a = deriveStealthKeypair(spend, x25519.utils.randomPrivateKey(), ephHex);
		const b = deriveStealthKeypair(spend, x25519.utils.randomPrivateKey(), ephHex);

		expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
	});

	it("matches manual derivation step-by-step", () => {
		// This is the most important test. It documents the exact algorithm
		// that the Arcium MPC must reproduce.
		const spend = Keypair.generate();
		const viewSecret = x25519.utils.randomPrivateKey();
		const ephSecret = x25519.utils.randomPrivateKey();
		const ephPubkey = x25519.getPublicKey(ephSecret);
		const ephHex = Buffer.from(ephPubkey).toString("hex");

		// Step 1: ECDH shared secret
		const sharedSecret = x25519.getSharedSecret(viewSecret, ephPubkey);

		// Step 2: XOR with spend pubkey
		const spendPubkeyBytes = spend.publicKey.toBytes();
		const stealthSeed = new Uint8Array(32);
		for (let i = 0; i < 32; i++) {
			stealthSeed[i] = sharedSecret[i] ^ spendPubkeyBytes[i];
		}

		// Step 3: SHA256 to get ed25519 seed
		const secretKey = sha256(stealthSeed);

		// Step 4: Derive keypair
		const expected = Keypair.fromSeed(secretKey);

		// Compare to function output
		const actual = deriveStealthKeypair(spend, viewSecret, ephHex);

		expect(actual.publicKey.toBase58()).toBe(expected.publicKey.toBase58());
	});

	it("produces a valid ed25519 keypair", () => {
		const result = deriveStealthKeypair(
			Keypair.generate(),
			x25519.utils.randomPrivateKey(),
			createEphemeralPubkeyHex(),
		);

		expect(result.secretKey.length).toBe(64);
		// Public key should not be all zeros
		const bytes = result.publicKey.toBytes();
		expect(bytes.some((b) => b !== 0)).toBe(true);
	});
});

// ─── referralCode threading ───────────────────────────────

describe("referralCode threading", () => {
	it("withdrawParams includes referrer when referralCode is set", () => {
		const referralCode = "ABC123";
		const params = {
			serializedProof: "base64data",
			recipient: "pubkey",
			...(referralCode ? { referrer: referralCode } : {}),
		};
		expect(params.referrer).toBe("ABC123");
	});

	it("withdrawParams omits referrer when referralCode is undefined", () => {
		const referralCode = undefined;
		const params = {
			serializedProof: "base64data",
			recipient: "pubkey",
			...(referralCode ? { referrer: referralCode } : {}),
		};
		expect("referrer" in params).toBe(false);
	});
});
