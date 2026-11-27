import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "@/lib/exchange-registry/canonical";
import {
  parseSignature,
  verifyRegistrySignature,
  type SignatureContext,
} from "@/lib/exchange-registry/signature";
import {
  exchangeEntry,
  registryBody,
  signBody,
  signUnderLabel,
  SIGNING_LABEL,
  TEST_NOW,
} from "./fixtures/signed-registry";

const PRIMARY = Keypair.random();
const BACKUP = Keypair.random();
const OUTSIDER = Keypair.random();
const ADDED = Keypair.random().publicKey();

const context = (over: Partial<SignatureContext> = {}): SignatureContext => ({
  keys: [PRIMARY.publicKey(), BACKUP.publicKey()],
  bundledSequence: 5,
  now: TEST_NOW,
  ...over,
});

const body = () => registryBody([exchangeEntry(ADDED)]);
const verify = (doc: ReturnType<typeof signBody>, over: Partial<SignatureContext> = {}) =>
  verifyRegistrySignature(doc, doc.signature, context(over));

describe("canonicalJson", () => {
  test("sorts keys and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, "x", { d: 2, c: 3 }] })).toBe(
      '{"a":[true,"x",{"c":3,"d":2}],"b":1}'
    );
  });

  test("is the same text whatever order the keys arrive in", () => {
    expect(canonicalJson({ a: 1, b: { y: 1, x: 2 } })).toBe(
      canonicalJson({ b: { x: 2, y: 1 }, a: 1 })
    );
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("escapes strings the way JSON.stringify does, lone surrogates and separators included", () => {
    const value = { k: 'a b\ud800"\\\n' };
    expect(canonicalJson(value)).toBe(`{"k":${JSON.stringify(value.k)}}`);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["negative zero", -0],
    ["an unsafe integer", 2 ** 60],
    ["a Date", new Date(0)],
    ["a class instance", new (class Box {})()],
    ["a sparse array", [1, , 3]],
    ["a nested null", { a: [null] }],
    ["a bigint", BigInt(1)],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe("parseSignature", () => {
  const valid = () => signBody(body(), PRIMARY).signature;

  test("takes a well-formed envelope", () => {
    expect(parseSignature(valid())).toEqual(valid());
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
  ])("refuses %s", (_n, raw) => {
    expect(parseSignature(raw)).toBeNull();
  });

  test("refuses an unknown or a missing field", () => {
    expect(parseSignature({ ...valid(), extra: 1 })).toBeNull();
    const { issuedAt: _omit, ...missing } = valid();
    expect(parseSignature(missing)).toBeNull();
  });

  test("refuses another format, a bad sequence and a bad date", () => {
    expect(parseSignature({ ...valid(), format: 2 })).toBeNull();
    for (const sequence of [0, -1, 1.5, "5", 2 ** 60]) {
      expect(parseSignature({ ...valid(), sequence })).toBeNull();
    }
    for (const issuedAt of ["2026-02-30", "2026-1-01", "20261127", "2026-11-27T00:00:00Z", 5]) {
      expect(parseSignature({ ...valid(), issuedAt })).toBeNull();
    }
  });

  test("refuses a signature that is not canonical 64-byte base64", () => {
    const good = valid().signature;
    const bad = [
      good.slice(0, -4),
      `${good}AAAA`,
      `${good.slice(0, 10)} ${good.slice(11)}`,
      `-${good.slice(1)}`,
      `_${good.slice(1)}`,
      "",
      5,
    ];
    for (const signature of bad) expect(parseSignature({ ...valid(), signature })).toBeNull();
  });
});

describe("verifyRegistrySignature", () => {
  test("accepts a current signature by the primary key", () => {
    expect(verify(signBody(body(), PRIMARY))).toEqual({ ok: true, sequence: 5 });
  });

  test("accepts one by the backup key", () => {
    expect(verify(signBody(body(), BACKUP)).ok).toBe(true);
  });

  test("accepts a body whose keys arrive in another order and with other whitespace", () => {
    const doc = signBody(body(), PRIMARY);
    const reparsed = JSON.parse(JSON.stringify(doc, null, 4)) as typeof doc;
    const shuffled = Object.fromEntries(Object.entries(reparsed).reverse());
    expect(verifyRegistrySignature(shuffled, doc.signature, context()).ok).toBe(true);
  });

  test("ignores fields outside the signed five, including the signature itself", () => {
    const doc = { ...signBody(body(), PRIMARY), etag: "abc" };
    expect(verifyRegistrySignature(doc, doc.signature, context()).ok).toBe(true);
  });

  test("refuses a signature by a key that is not pinned", () => {
    expect(verify(signBody(body(), OUTSIDER))).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses every key when none is pinned", () => {
    expect(verify(signBody(body(), PRIMARY), { keys: [] })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  test("a pinned entry that is not a public key refuses instead of throwing", () => {
    expect(verify(signBody(body(), PRIMARY), { keys: ["not-a-key"] })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  test("refuses a forged signature of the right shape", () => {
    const doc = signBody(body(), PRIMARY);
    const forged = { ...doc.signature, signature: Buffer.alloc(64, 7).toString("base64") };
    expect(verifyRegistrySignature(doc, forged, context())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  describe("a tampered payload", () => {
    const tampers: [string, (d: ReturnType<typeof signBody>) => unknown][] = [
      [
        "an entry's mediator flag",
        (d) => ({ ...d, entries: [{ ...(d.entries[0] as object), requiresMediator: false }] }),
      ],
      [
        "an entry's name",
        (d) => ({ ...d, entries: [{ ...(d.entries[0] as object), name: "Other" }] }),
      ],
      [
        "an entry's memo type",
        (d) => ({ ...d, entries: [{ ...(d.entries[0] as object), memoType: "id" }] }),
      ],
      [
        "an added entry",
        (d) => ({ ...d, entries: [...d.entries, exchangeEntry(Keypair.random().publicKey())] }),
      ],
      ["a removed entry", (d) => ({ ...d, entries: [] })],
      [
        "the order of entries",
        (d) => ({ ...d, entries: [exchangeEntry(Keypair.random().publicKey()), ...d.entries] }),
      ],
      ["validUntil", (d) => ({ ...d, validUntil: "2027-03-01" })],
      ["lastVerified", (d) => ({ ...d, lastVerified: "2026-11-26" })],
      ["version", (d) => ({ ...d, version: "other" })],
      ["source", (d) => ({ ...d, source: "https://elsewhere.example" })],
    ];
    for (const [name, change] of tampers) {
      test(`refuses ${name}`, () => {
        const doc = signBody(body(), PRIMARY);
        expect(verifyRegistrySignature(change(doc), doc.signature, context())).toEqual({
          ok: false,
          reason: "bad-signature",
        });
      });
    }

    test("refuses a changed sequence or issue date in the envelope", () => {
      const doc = signBody(body(), PRIMARY);
      for (const changed of [
        { ...doc.signature, sequence: 6 },
        { ...doc.signature, issuedAt: "2026-11-26" },
      ]) {
        expect(verifyRegistrySignature(doc, changed, context())).toEqual({
          ok: false,
          reason: "bad-signature",
        });
      }
    });
  });

  test("refuses a signature over another document", () => {
    const a = signBody(body(), PRIMARY);
    const b = signBody(registryBody([exchangeEntry(Keypair.random().publicKey())]), PRIMARY);
    expect(verifyRegistrySignature(b, a.signature, context())).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  describe("a missing or damaged envelope", () => {
    test.each([
      ["undefined", undefined],
      ["null", null],
      ["an empty object", {}],
      ["a string", "AAAA"],
    ])("is malformed: %s", (_n, envelope) => {
      expect(verifyRegistrySignature(body(), envelope, context())).toEqual({
        ok: false,
        reason: "malformed",
      });
    });

    test("a truncated or extended signature is malformed", () => {
      const doc = signBody(body(), PRIMARY);
      const raw = Buffer.from(doc.signature.signature, "base64");
      for (const bytes of [
        raw.subarray(0, 63),
        Buffer.concat([raw, Buffer.from([0])]),
        Buffer.alloc(0),
      ]) {
        const envelope = { ...doc.signature, signature: bytes.toString("base64") };
        expect(verifyRegistrySignature(doc, envelope, context())).toEqual({
          ok: false,
          reason: "malformed",
        });
      }
    });

    test("a signature with non-canonical trailing bits is malformed even though it decodes the same", () => {
      const doc = signBody(body(), PRIMARY);
      const good = doc.signature.signature;
      const last = good[85] as string;
      const alias = `${good.slice(0, 85)}${String.fromCharCode(last.charCodeAt(0) + 1)}==`;
      expect(Buffer.from(alias, "base64").equals(Buffer.from(good, "base64"))).toBe(true);
      expect(
        verifyRegistrySignature(doc, { ...doc.signature, signature: alias }, context())
      ).toEqual({ ok: false, reason: "malformed" });
    });

    test("a body without all five fields, or that cannot be written canonically, is malformed", () => {
      const doc = signBody(body(), PRIMARY);
      const { source: _omit, ...withoutSource } = doc;
      expect(verifyRegistrySignature(withoutSource, doc.signature, context()).ok).toBe(false);
      expect(verifyRegistrySignature(null, doc.signature, context())).toEqual({
        ok: false,
        reason: "malformed",
      });
      const floaty = { ...doc, entries: [{ n: 1.5 }] };
      expect(verifyRegistrySignature(floaty, doc.signature, context())).toEqual({
        ok: false,
        reason: "malformed",
      });
    });
  });

  describe("domain separation", () => {
    const sign = (label: string) => {
      const doc = body();
      const envelope = signUnderLabel(doc, PRIMARY, label, { sequence: 5, issuedAt: "2026-11-27" });
      return verifyRegistrySignature(doc, envelope, context());
    };

    test("the label itself verifies", () => {
      expect(sign(SIGNING_LABEL).ok).toBe(true);
    });

    test("a signature without the label, or under another label or version, does not", () => {
      for (const label of [
        "",
        "lumenwipe.exchange-registry.signature.v2",
        "lumenwipe.other.signature.v1",
      ]) {
        expect(sign(label)).toEqual({ ok: false, reason: "bad-signature" });
      }
    });

    test("a transaction-style signature over a 32-byte hash cannot be the signed bytes", () => {
      const doc = body();
      const hash = Buffer.alloc(32, 9);
      const envelope = {
        format: 1 as const,
        sequence: 5,
        issuedAt: "2026-11-27",
        signature: Buffer.from(PRIMARY.sign(hash)).toString("base64"),
      };
      expect(verifyRegistrySignature(doc, envelope, context()).ok).toBe(false);
    });
  });

  describe("rollback", () => {
    test("a document older than the bundled one is refused", () => {
      expect(verify(signBody(body(), PRIMARY, { sequence: 4 }))).toEqual({
        ok: false,
        reason: "stale-sequence",
      });
    });

    test("one with the bundled sequence is the bundled document and is accepted", () => {
      expect(verify(signBody(body(), PRIMARY, { sequence: 5 })).ok).toBe(true);
    });

    test("a newer one is accepted", () => {
      expect(verify(signBody(body(), PRIMARY, { sequence: 6 }))).toEqual({ ok: true, sequence: 6 });
    });

    test("an older valid document replayed after a newer one is bundled is refused", () => {
      const older = signBody(body(), PRIMARY, { sequence: 7 });
      expect(verify(older, { bundledSequence: 8 })).toEqual({
        ok: false,
        reason: "stale-sequence",
      });
    });
  });

  describe("freshness", () => {
    test("is usable through the last second of validUntil", () => {
      const doc = signBody(registryBody([], { validUntil: "2026-12-01" }), PRIMARY);
      expect(verify(doc, { now: new Date("2026-12-01T23:59:59Z") }).ok).toBe(true);
    });

    test("is stale once validUntil has passed", () => {
      const doc = signBody(registryBody([], { validUntil: "2026-12-01" }), PRIMARY);
      expect(verify(doc, { now: new Date("2026-12-02T00:00:00Z") })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    test("an unreadable validUntil is stale", () => {
      const doc = signBody(registryBody([], { validUntil: "soon" }), PRIMARY);
      expect(verify(doc)).toEqual({ ok: false, reason: "expired" });
    });

    test("a clock a day behind still accepts a document issued today, two days behind does not", () => {
      const doc = signBody(body(), PRIMARY, { issuedAt: "2026-11-27" });
      expect(verify(doc, { now: new Date("2026-11-26T00:00:00Z") }).ok).toBe(true);
      expect(verify(doc, { now: new Date("2026-11-25T23:59:59Z") })).toEqual({
        ok: false,
        reason: "future-dated",
      });
    });

    test("a document issued after it expires is future-dated", () => {
      const doc = signBody(registryBody([], { validUntil: "2026-11-30" }), PRIMARY, {
        issuedAt: "2026-12-01",
      });
      expect(verify(doc, { now: new Date("2026-11-30T12:00:00Z") })).toEqual({
        ok: false,
        reason: "future-dated",
      });
    });
  });
});
