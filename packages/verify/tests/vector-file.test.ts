/** The vector file's own contract: its shape, its coverage, that it holds no secret, and that
 *  it is exactly what the generator builds. */
import { describe, expect, test } from "bun:test";
import { StrKey, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { VECTOR_FILE, VECTOR_FILE_TEXT } from "./vectors";

const { vectors } = VECTOR_FILE;
const accepts = vectors.filter((v) => v.verdict === "accept");
const rejects = vectors.filter((v) => v.verdict === "reject");
const byName = new Map(vectors.map((v) => [v.name, v]));

describe("close-v1.json", () => {
  test("is schema 1 with unique names", () => {
    expect(VECTOR_FILE.schema).toBe(1);
    expect(VECTOR_FILE.name).toBe("close-v1");
    expect(byName.size).toBe(vectors.length);
  });

  test("covers the shapes the issue names", () => {
    for (const name of [
      "minimal-direct-merge",
      "exchange-close-through-intermediary",
      "claimable-balance-claim",
      "multisig-close",
    ]) {
      expect(byName.get(name)?.verdict).toBe("accept");
    }
    for (const name of [
      "unknown-operation",
      "wrong-merge-destination",
      "signer-added",
      "threshold-raised",
      "memo-value-changed",
      "memo-type-changed",
    ]) {
      expect(byName.get(name)?.verdict).toBe("reject");
    }
    expect(rejects.length).toBeGreaterThanOrEqual(10);
    expect(vectors.filter((v) => v.verdict === "accept" && v.provenance).length).toBe(2);
  });

  test("makes every rejection one named mutation of an accepted vector", () => {
    for (const vector of rejects) {
      if (vector.verdict !== "reject") continue;
      const base = byName.get(vector.base);
      expect(base?.verdict).toBe("accept");
      expect(vector.mutation.length).toBeGreaterThan(0);
      expect(vector.error.message.length).toBeGreaterThan(0);
      expect(vector.input.unsignedXdr).not.toBe(base!.input.unsignedXdr);
      // Only the transaction is mutated: the expectation and the clock stay the base's.
      expect(vector.input.expected).toEqual(base!.input.expected);
      expect(vector.nowSeconds).toBe(base!.nowSeconds);
    }
  });

  test("decodes every transaction on testnet", () => {
    for (const vector of vectors) {
      expect(vector.input.network).toBe("testnet");
      expect(() =>
        TransactionBuilder.fromXdr(vector.input.unsignedXdr, Networks.TESTNET)
      ).not.toThrow();
    }
    expect(accepts.length).toBeGreaterThanOrEqual(9);
  });

  test("holds no secret key", () => {
    const candidates = VECTOR_FILE_TEXT.match(/S[A-Z2-7]{55}/g) ?? [];
    expect(candidates.filter((c) => StrKey.isValidEd25519SecretSeed(c))).toEqual([]);
  });

  test("is exactly what the generator builds (--check)", () => {
    const run = Bun.spawnSync(["bun", "scripts/generate-vectors.ts", "--check"], {
      cwd: new URL("..", import.meta.url).pathname,
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
