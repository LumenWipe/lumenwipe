/**
 * What an integrator can and cannot do with a registry signature through the built package, in
 * both module formats. The signing keys are the ones pinned in the release; nothing on the input
 * names another set, so a snapshot signed by a key of the caller's choosing enables nothing.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createRequire } from "node:module";
import { Keypair } from "@stellar/stellar-sdk";
import {
  exchangeEntry,
  registryBody,
  signBody,
} from "../../../apps/web/tests/unit/fixtures/signed-registry";
import { VECTOR_FILE } from "./vectors";

type Verifier = typeof import("../src/index");

const ESM_ENTRY = new URL("../dist/index.js", import.meta.url).href;
const CJS_ENTRY = new URL("../dist/index.cjs", import.meta.url).pathname;

const formats: [string, () => Promise<Verifier>][] = [
  ["esm", async () => (await import(ESM_ENTRY)) as Verifier],
  ["cjs", async () => createRequire(import.meta.url)(CJS_ENTRY) as Verifier],
];

const BASE = VECTOR_FILE.vectors.find(
  (v) => v.name === "snapshot-enables-intermediary-for-destination"
);
if (BASE === undefined || BASE.verdict !== "reject") throw new Error("the base vector moved");

afterEach(() => setSystemTime());

for (const [format, load] of formats) {
  describe(`dist (${format}): a signed registry snapshot`, async () => {
    const verifier = await load();
    const signer = Keypair.random();
    const destination = BASE.input.expected.destination;
    const body = signBody(
      registryBody([exchangeEntry(destination)], { validUntil: "2027-02-15" }),
      signer,
      { sequence: 1000 }
    );
    const snapshot = {
      ...body,
      trustRoots: [signer.publicKey()],
      publicKeys: [signer.publicKey()],
    };

    test("signed by a key of the caller's choosing, with keys named on the input, still refuses the hand-off", () => {
      setSystemTime(new Date(BASE.nowSeconds * 1000));
      const run = () =>
        verifier.verifyCloseTransaction({
          ...BASE.input,
          servedRegistry: snapshot as never,
        });
      expect(run).toThrow(verifier.VerificationError);
      try {
        run();
      } catch (error) {
        expect((error as InstanceType<Verifier["VerificationError"]>).code).toBe(
          "merge_destination_mismatch"
        );
      }
    });

    test("requiresMediator answers from the bundle and pinned keys only", () => {
      setSystemTime(new Date(BASE.nowSeconds * 1000));
      expect(verifier.requiresMediator(destination, "testnet")).toBe(false);
      expect(verifier.requiresMediator(destination, "testnet", snapshot as never)).toBe(false);
      const unsigned = { ...snapshot, signature: undefined };
      expect(verifier.requiresMediator(destination, "testnet", unsigned as never)).toBe(false);
      expect(
        verifier.requiresMediator(
          "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
          "mainnet"
        )
      ).toBe(true);
    });
  });
}
