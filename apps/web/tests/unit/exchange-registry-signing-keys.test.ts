import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import embedded from "@registry/exchange-registry.json";
import embeddedSignature from "@registry/exchange-registry.sig.json";
import { bundledRegistry } from "@/lib/exchange-registry";
import { parseSignature, verifyRegistrySignature } from "@/lib/exchange-registry/signature";
import { REGISTRY_SIGNING_KEYS } from "@/lib/exchange-registry/trust-roots";

const PRIMARY = "GAKGKRCTIPJIFS4UAL6TZEXW3ZUUYBFBPBAVNG37NKILQQ5ZSW3VGDTK";
const BACKUP = "GAOXVNB4UHWUOXDLSQXTPUJUZWRHKO35ZP5P5XZNPESMEIPUL3X66PDD";
const ROOT = resolve(import.meta.dir, "../../../..");

describe("the pinned registry signing keys", () => {
  test("are the primary and the backup, in that order, and nothing else", () => {
    expect([...REGISTRY_SIGNING_KEYS]).toEqual([PRIMARY, BACKUP]);
  });

  test("are valid Stellar public keys", () => {
    for (const key of REGISTRY_SIGNING_KEYS) expect(StrKey.isValidEd25519PublicKey(key)).toBe(true);
  });

  test("are the keys docs/security-scope.md lists, and it lists no other public key in that section", () => {
    const doc = readFileSync(resolve(ROOT, "docs/security-scope.md"), "utf8");
    const start = doc.indexOf("## Registry signing keys");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = doc.indexOf("\n## ", start + 1);
    const section = doc.slice(start, next === -1 ? undefined : next);
    const listed = [...section.matchAll(/\bG[A-Z2-7]{55}\b/g)].map((m) => m[0]);
    expect(listed.sort()).toEqual([PRIMARY, BACKUP].sort());
  });
});

describe("the committed registry signature", () => {
  const envelope = parseSignature(embeddedSignature);

  test("is a version 1 envelope", () => {
    expect(envelope).not.toBeNull();
  });

  test("verifies under the pinned keys for the committed registry, as of the day it was issued", () => {
    const verdict = verifyRegistrySignature(embedded, envelope, {
      keys: REGISTRY_SIGNING_KEYS,
      bundledSequence: 0,
      now: new Date(`${envelope?.issuedAt}T12:00:00Z`),
    });
    expect(verdict).toEqual({ ok: true, sequence: envelope?.sequence as number });
  });

  test("is the sequence the bundled floor holds", () => {
    expect(bundledRegistry().sequence).toBe(envelope?.sequence as number);
  });
});
