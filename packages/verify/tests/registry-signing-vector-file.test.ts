/** The registry-signing vector file's own contract: its shape, that every failure reason has a
 *  vector, that it holds no secret, that its production vector names the pinned keys, and that it
 *  is exactly what the generator builds. The vectors themselves run against the verifier in
 *  apps/web/tests/unit/registry-signing-conformance.test.ts. */
import { describe, expect, test } from "bun:test";
import { StrKey } from "@stellar/stellar-sdk";
import { REGISTRY_SIGNING_KEYS } from "../../../apps/web/lib/exchange-registry/trust-roots";
import { serialize } from "../scripts/generate-vectors";
import { buildRegistrySigningVectorFile } from "../scripts/registry-signing-vectors";
import { REGISTRY_SIGNING_VECTOR_FILE, REGISTRY_SIGNING_VECTOR_FILE_TEXT } from "./vectors";

const { vectors } = REGISTRY_SIGNING_VECTOR_FILE;
const byName = new Map(vectors.map((v) => [v.name, v]));

describe("registry-signing-v1.json", () => {
  test("is schema 1 with unique names", () => {
    expect(REGISTRY_SIGNING_VECTOR_FILE.schema).toBe(1);
    expect(REGISTRY_SIGNING_VECTOR_FILE.name).toBe("registry-signing-v1");
    expect(byName.size).toBe(vectors.length);
  });

  test("covers a signed addition's key, rollback and freshness cases", () => {
    for (const name of [
      "signed-by-primary-key",
      "signed-by-backup-key",
      "sequence-equal-to-bundled",
      "last-second-of-valid-until",
      "production-signed-registry",
    ]) {
      expect(byName.get(name)?.verdict).toBe("accept");
    }
    for (const name of [
      "forged-signature",
      "wrong-key",
      "tampered-entry",
      "tampered-valid-until",
      "tampered-sequence",
      "missing-signature",
      "truncated-signature",
      "stale-sequence-replay",
      "stale-document-past-valid-until",
      "no-domain-label",
      "issued-in-the-future",
    ]) {
      expect(byName.get(name)?.verdict).toBe("reject");
    }
  });

  test("has a rejection for every failure reason", () => {
    const reasons = new Set(vectors.flatMap((v) => (v.verdict === "reject" ? [v.reason] : [])));
    expect([...reasons].sort()).toEqual([
      "bad-signature",
      "expired",
      "future-dated",
      "malformed",
      "stale-sequence",
    ]);
  });

  test("states the exact signed text of an accepted vector", () => {
    const vector = byName.get("signed-by-primary-key");
    expect(vector?.verdict === "accept" && vector.signedText).toMatch(
      /^lumenwipe\.exchange-registry\.signature\.v1\n\{"format":1,"issuedAt":"2026-11-27","registry":\{"entries":\[/
    );
  });

  test("names the pinned keys in the production vector and no other vector's keys are pinned", () => {
    const production = byName.get("production-signed-registry");
    expect(production?.publicKeys).toEqual([...REGISTRY_SIGNING_KEYS]);
    for (const vector of vectors) {
      if (vector.name === "production-signed-registry") continue;
      for (const key of vector.publicKeys) expect(REGISTRY_SIGNING_KEYS).not.toContain(key);
    }
  });

  test("holds no secret seed", () => {
    for (const match of REGISTRY_SIGNING_VECTOR_FILE_TEXT.matchAll(/\bS[A-Z2-7]{55}\b/g)) {
      expect(StrKey.isValidEd25519SecretSeed(match[0])).toBe(false);
    }
  });

  test("is exactly what the generator builds", () => {
    expect(REGISTRY_SIGNING_VECTOR_FILE_TEXT).toBe(serialize(buildRegistrySigningVectorFile()));
  });
});
