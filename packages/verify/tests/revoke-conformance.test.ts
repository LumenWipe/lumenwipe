/**
 * Runs every allowance-revocation vector against the built package, in both module formats, so
 * what is tested is what an integrator installs. `bun run test` builds dist first. The web runs
 * the same file against its own anchor
 * (apps/web/tests/unit/verify-revoke-allowance-conformance.test.ts).
 *
 * The clock goes in as `nowSeconds`, never through the system clock, so a build that stopped
 * passing it on would judge the vectors against today and fail.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { REVOKE_VECTOR_FILE } from "./vectors";

type Verifier = typeof import("../src/index");

// Not literal specifiers: the type-check runs before any build, when dist does not exist yet.
const ESM_ENTRY = new URL("../dist/index.js", import.meta.url).href;
const CJS_ENTRY = new URL("../dist/index.cjs", import.meta.url).pathname;

const formats: [string, () => Promise<Verifier>][] = [
  ["esm", async () => (await import(ESM_ENTRY)) as Verifier],
  ["cjs", async () => createRequire(import.meta.url)(CJS_ENTRY) as Verifier],
];

for (const [format, load] of formats) {
  describe(`dist (${format}): revoke-allowance-v1`, async () => {
    const verifier = await load();

    for (const vector of REVOKE_VECTOR_FILE.vectors) {
      test(`${vector.verdict}: ${vector.name}`, () => {
        const { unsignedXdr, networkPassphrase, expected } = vector.input;
        const run = () =>
          verifier.verifyRevokeAllowanceTransaction(
            unsignedXdr,
            networkPassphrase,
            expected,
            vector.nowSeconds
          );
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
        expect(thrown).toBeInstanceOf(verifier[vector.error.class]);
        expect((thrown as Error).name).toBe(vector.error.class);
        expect((thrown as { code: string }).code).toBe(vector.error.code);
        expect((thrown as Error).message).toBe(vector.error.message);
      });
    }
  });
}
