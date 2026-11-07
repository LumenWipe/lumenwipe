import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { signerStanding, signerStandingText } from "@/lib/stellar/signer-standing";
import type { AccountSigner } from "@/types/account";

const master = Keypair.random().publicKey();
const cosigner = Keypair.random().publicKey();
const dormant = Keypair.random().publicKey();
const SIGNERS: AccountSigner[] = [
  { key: master, weight: 1, type: "ed25519_public_key" },
  { key: cosigner, weight: 2, type: "ed25519_public_key" },
  { key: dormant, weight: 0, type: "ed25519_public_key" },
];

test("signer-standing › a listed key with weight is a signer with that weight", () => {
  expect(signerStanding(cosigner, SIGNERS)).toEqual({ kind: "signer", weight: 2 });
  expect(signerStandingText(signerStanding(cosigner, SIGNERS))).toBe(
    "Signer on this account, weight 2"
  );
});

test("signer-standing › a key the account does not list is not a signer", () => {
  const stranger = Keypair.random().publicKey();
  expect(signerStanding(stranger, SIGNERS)).toEqual({ kind: "not-signer" });
  expect(signerStanding(stranger, [])).toEqual({ kind: "not-signer" });
  expect(signerStandingText({ kind: "not-signer" })).toBe("Not a signer on this account");
});

test("signer-standing › a key listed with weight 0 cannot sign", () => {
  expect(signerStanding(dormant, SIGNERS)).toEqual({ kind: "zero-weight" });
  expect(signerStandingText({ kind: "zero-weight" })).toBe(
    "Not a signer on this account: its weight is 0"
  );
});
