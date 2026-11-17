/**
 * The shared allowance-revocation vectors, run against the web's own anchor. `@lumenwipe/verify`
 * runs the same file against its built bundle (packages/verify/tests/revoke-conformance.test.ts),
 * so a change to what the anchor accepts, the code it gives a refusal, or how it words one fails
 * here until the vectors, and with them the published package, are updated to match. Regenerate
 * them with `bun run --filter '@lumenwipe/verify' vectors`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VerificationError } from "@/lib/stellar/verification-error";
import {
  RevokeAllowanceVerificationError,
  verifyRevokeAllowanceTransaction,
  type RevokeAllowanceExpectation,
} from "@/lib/stellar/verify-revoke-allowance";

interface Vector {
  name: string;
  verdict: "accept" | "reject";
  nowSeconds: number;
  input: { unsignedXdr: string; networkPassphrase: string; expected: RevokeAllowanceExpectation };
  error?: {
    class: "RevokeAllowanceVerificationError" | "VerificationError";
    code: string;
    message: string;
  };
}

const VECTOR_FILE = new URL(
  "../../../../packages/verify/vectors/revoke-allowance-v1.json",
  import.meta.url
);
const { schema, vectors }: { schema: number; vectors: Vector[] } = JSON.parse(
  readFileSync(VECTOR_FILE, "utf8")
);
const CLASSES = { RevokeAllowanceVerificationError, VerificationError };

test("the revocation vector file is schema 1 and not empty", () => {
  expect(schema).toBe(1);
  expect(vectors.length).toBeGreaterThan(0);
});

for (const vector of vectors) {
  test(`revoke-allowance-v1 › ${vector.verdict}: ${vector.name}`, () => {
    const { unsignedXdr, networkPassphrase, expected } = vector.input;
    const run = () =>
      verifyRevokeAllowanceTransaction(unsignedXdr, networkPassphrase, expected, vector.nowSeconds);
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
    expect(thrown).toBeInstanceOf(CLASSES[vector.error!.class]);
    expect((thrown as Error).name).toBe(vector.error!.class);
    expect((thrown as { code: string }).code).toBe(vector.error!.code);
    expect((thrown as Error).message).toBe(vector.error!.message);
  });
}
