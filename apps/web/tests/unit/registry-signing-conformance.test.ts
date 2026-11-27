/**
 * The registry-signing vectors, run against the verifier the web and the package both compile
 * from. Regenerate them with `bun run --filter '@lumenwipe/verify' vectors`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyRegistrySignature } from "@/lib/exchange-registry/signature";

interface Vector {
  name: string;
  verdict: "accept" | "reject";
  nowSeconds: number;
  bundledSequence: number;
  publicKeys: string[];
  registry: unknown;
  signature?: unknown;
  sequence?: number;
  reason?: string;
}

const FILE = new URL(
  "../../../../packages/verify/vectors/registry-signing-v1.json",
  import.meta.url
);
const { vectors }: { vectors: Vector[] } = JSON.parse(readFileSync(FILE, "utf8"));

describe("registry-signing-v1", () => {
  for (const vector of vectors) {
    test(`${vector.verdict}: ${vector.name}`, () => {
      const verdict = verifyRegistrySignature(vector.registry, vector.signature, {
        keys: vector.publicKeys,
        bundledSequence: vector.bundledSequence,
        now: new Date(vector.nowSeconds * 1000),
      });
      if (vector.verdict === "accept") {
        expect(verdict).toEqual({ ok: true, sequence: vector.sequence as number });
      } else {
        expect(verdict).toEqual({ ok: false, reason: vector.reason as never });
      }
    });
  }
});
