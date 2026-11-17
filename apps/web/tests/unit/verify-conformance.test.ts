/**
 * The shared conformance vectors, run against the web's own verifier. `@lumenwipe/verify` runs the
 * same file against its built bundle (packages/verify/tests/conformance.test.ts), so a change to
 * what `verify()` accepts, the code it gives a refusal, or how it words one fails here until the
 * vectors, and with them the published package, are updated to match. Regenerate them with
 * `bun run --filter '@lumenwipe/verify' vectors`.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VerificationError, verifyCloseTransaction } from "@/lib/stellar/verify";
import type { VerificationErrorCode } from "@/lib/stellar/verification-error";

type Expected = Parameters<typeof verifyCloseTransaction>[0]["expected"];

interface Vector {
  name: string;
  verdict: "accept" | "reject";
  nowSeconds: number;
  input: { unsignedXdr: string; network: "mainnet" | "testnet"; expected: Expected };
  error?: { name: string; code: VerificationErrorCode; message: string };
}

const VECTOR_FILE = new URL("../../../../packages/verify/vectors/close-v1.json", import.meta.url);
const { schema, vectors }: { schema: number; vectors: Vector[] } = JSON.parse(
  readFileSync(VECTOR_FILE, "utf8")
);

afterEach(() => {
  setSystemTime();
});

test("the vector file is schema 1 and not empty", () => {
  expect(schema).toBe(1);
  expect(vectors.filter((v) => v.verdict === "accept").length).toBeGreaterThan(0);
  expect(vectors.filter((v) => v.verdict === "reject").length).toBeGreaterThanOrEqual(10);
});

test("refuses the vector that carries an operation it cannot describe", () => {
  const vector = vectors.find((v) => v.name === "unknown-operation");
  expect(vector?.verdict).toBe("reject");
  setSystemTime(new Date(vector!.nowSeconds * 1000));
  expect(() => verifyCloseTransaction(vector!.input)).toThrow(
    new VerificationError(
      "operation_unknown",
      "The transaction contains an unrecognized operation."
    )
  );
});

describe("verify() against the close-v1 conformance vectors", () => {
  for (const vector of vectors) {
    test(`${vector.verdict}: ${vector.name}`, () => {
      setSystemTime(new Date(vector.nowSeconds * 1000));
      const run = () => verifyCloseTransaction(vector.input);
      if (vector.verdict === "accept") {
        expect(run).not.toThrow();
        return;
      }
      let thrown: unknown = null;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(VerificationError);
      expect((thrown as VerificationError).code).toBe(vector.error!.code);
      expect((thrown as Error).message).toBe(vector.error!.message);
    });
  }
});
