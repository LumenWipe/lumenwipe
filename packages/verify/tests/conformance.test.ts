/**
 * Runs every conformance vector against the built package, in both module formats, so what is
 * tested is what an integrator installs. `bun run test` builds dist first. The web runs the same
 * file against its own verifier (apps/web/tests/unit/verify-conformance.test.ts).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createRequire } from "node:module";
import { VECTOR_FILE } from "./vectors";

type Verifier = typeof import("../src/index");

// Not literal specifiers: the type-check runs before any build, when dist does not exist yet.
const ESM_ENTRY = new URL("../dist/index.js", import.meta.url).href;
const CJS_ENTRY = new URL("../dist/index.cjs", import.meta.url).pathname;

const formats: [string, () => Promise<Verifier>][] = [
  ["esm", async () => (await import(ESM_ENTRY)) as Verifier],
  ["cjs", async () => createRequire(import.meta.url)(CJS_ENTRY) as Verifier],
];

afterEach(() => {
  setSystemTime();
});

for (const [format, load] of formats) {
  describe(`dist (${format})`, async () => {
    const verifier = await load();

    for (const vector of VECTOR_FILE.vectors) {
      test(`${vector.verdict}: ${vector.name}`, () => {
        setSystemTime(new Date(vector.nowSeconds * 1000));
        const run = () => verifier.verifyCloseTransaction(vector.input);
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
        expect(thrown).toBeInstanceOf(verifier.VerificationError);
        expect((thrown as Error).name).toBe(vector.error.name);
        expect((thrown as Error).message).toBe(vector.error.message);
      });
    }
  });
}
