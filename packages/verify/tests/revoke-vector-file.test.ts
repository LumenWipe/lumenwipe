/** The allowance-revocation vector file's own contract: its shape, that every refusal code has a
 *  vector, that every rejection is a named mutation of an accepted vector, that it holds no
 *  secret, and that it is exactly what the generator builds. */
import { describe, expect, test } from "bun:test";
import { Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { VERIFICATION_ERROR_CODES } from "../../../apps/web/lib/stellar/verification-error";
import { REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES } from "../../../apps/web/lib/stellar/verify-revoke-allowance";
import { buildRevokeVectorFile } from "../scripts/revoke-vectors";
import { REVOKE_VECTOR_FILE, REVOKE_VECTOR_FILE_TEXT } from "./vectors";

const { vectors } = REVOKE_VECTOR_FILE;
const byName = new Map(vectors.map((v) => [v.name, v]));
const rejects = vectors.flatMap((v) => (v.verdict === "reject" ? [v] : []));

describe("revoke-allowance-v1.json", () => {
  test("is schema 1 with unique names", () => {
    expect(REVOKE_VECTOR_FILE.schema).toBe(1);
    expect(REVOKE_VECTOR_FILE.name).toBe("revoke-allowance-v1");
    expect(byName.size).toBe(vectors.length);
  });

  test("accepts a contract spender and an account spender", () => {
    expect(byName.get("revoke-contract-spender")?.verdict).toBe("accept");
    expect(byName.get("revoke-account-spender")?.verdict).toBe("accept");
  });

  test("has a rejection for every refusal code", () => {
    const covered = new Set(
      rejects
        .filter((v) => v.error.class === "RevokeAllowanceVerificationError")
        .map((v) => v.error.code)
    );
    expect([...covered].sort()).toEqual([...REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES].sort());
  });

  test("gives every rejection a registered code of its class", () => {
    const revoke = new Set<string>(REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES);
    const close = new Set<string>(VERIFICATION_ERROR_CODES);
    for (const vector of rejects) {
      const registered = vector.error.class === "VerificationError" ? close : revoke;
      expect(registered.has(vector.error.code)).toBe(true);
      expect(vector.error.message.length).toBeGreaterThan(0);
    }
  });

  test("makes every rejection one named mutation of an accepted vector's transaction", () => {
    for (const vector of rejects) {
      const base = byName.get(vector.base);
      expect(base?.verdict).toBe("accept");
      expect(vector.mutation.length).toBeGreaterThan(0);
      expect(vector.input.unsignedXdr).not.toBe(base!.input.unsignedXdr);
      expect(vector.input.expected).toEqual(base!.input.expected);
      expect(vector.input.networkPassphrase).toBe(base!.input.networkPassphrase);
      expect(vector.nowSeconds).toBe(base!.nowSeconds);
    }
  });

  test("decodes every transaction on testnet", () => {
    for (const vector of vectors) {
      expect(vector.input.networkPassphrase).toBe(Networks.TESTNET);
      expect(() =>
        TransactionBuilder.fromXdr(vector.input.unsignedXdr, Networks.TESTNET)
      ).not.toThrow();
    }
  });

  test("holds no secret key", () => {
    const candidates = REVOKE_VECTOR_FILE_TEXT.match(/S[A-Z2-7]{55}/g) ?? [];
    expect(candidates.filter((c) => StrKey.isValidEd25519SecretSeed(c))).toEqual([]);
  });

  test("is exactly what the generator builds", () => {
    expect(REVOKE_VECTOR_FILE_TEXT).toBe(`${JSON.stringify(buildRevokeVectorFile(), null, 2)}\n`);
  });
});
