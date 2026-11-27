import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  activeRegistry,
  bundledRegistry,
  fetchServedRegistry,
  mediatorAllowedFor,
  pinnedRegistryTrust,
  setRegistry,
} from "@/lib/exchange-registry";
import {
  mediatedByAddition,
  resolveServedRegistry,
  type RegistryEntry,
} from "@/lib/exchange-registry/merge";
import { REGISTRY_SIGNING_KEYS } from "@/lib/exchange-registry/trust-roots";
import { mediatorAllowedUnder } from "@/lib/stellar/verify";
import { exchangeEntry, registryBody, signBody, TEST_NOW } from "./fixtures/signed-registry";

const SIGNER = Keypair.random();
const ADDED = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const BUNDLED_MEDIATED = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

const FLOOR = {
  entries: bundledRegistry().entries,
  validUntil: bundledRegistry().validUntil,
};
const trust = (over: { bundledSequence?: number } = {}) => ({
  keys: [SIGNER.publicKey()],
  bundledSequence: 5,
  now: TEST_NOW,
  ...over,
});
const signed = (entries: unknown[], sequence = 5) =>
  signBody(registryBody(entries, { validUntil: FLOOR.validUntil }), SIGNER, { sequence });

beforeEach(() => setSystemTime(TEST_NOW));
afterEach(() => setSystemTime());

describe("resolveServedRegistry", () => {
  test("a verified signature marks an added exchange that needs the intermediary", () => {
    const resolved = resolveServedRegistry(FLOOR, signed([exchangeEntry(ADDED)]), trust());
    expect(resolved?.trust).toBe("signed");
    expect(resolved?.sequence).toBe(5);
    expect(resolved?.mediatedAdditions).toEqual([ADDED]);
  });

  test("the merge underneath is the plain stricter-only merge, signature or not", () => {
    const body = signed([exchangeEntry(ADDED), exchangeEntry(OTHER, { requiresMediator: false })]);
    const { signature: _drop, ...bare } = body;
    const withSig = resolveServedRegistry(FLOOR, body, trust());
    const without = resolveServedRegistry(FLOOR, bare, trust());
    expect(withSig?.entries).toEqual(without?.entries as RegistryEntry[]);
    expect(withSig?.validUntil).toBe(without?.validUntil as string);
    expect(withSig?.memoTypeDisputes).toEqual(without?.memoTypeDisputes as string[]);
  });

  test("a failed verification leaves exactly the unsigned result", () => {
    const body = signed([exchangeEntry(ADDED)]);
    const { signature: _drop, ...bare } = body;
    const unsigned = resolveServedRegistry(FLOOR, bare, trust());
    expect(unsigned?.trust).toBe("unsigned");
    expect(unsigned?.sequence).toBeNull();
    expect(unsigned?.mediatedAdditions).toEqual([]);
    const failures: unknown[] = [
      { ...body, entries: [exchangeEntry(ADDED, { name: "Changed" })] },
      { ...body, signature: { ...body.signature, signature: Buffer.alloc(64).toString("base64") } },
      { ...body, signature: "AAAA" },
      signed([exchangeEntry(ADDED)], 4),
    ];
    for (const failure of failures) {
      const resolved = resolveServedRegistry(FLOOR, failure, trust());
      expect(resolved?.trust).toBe("unsigned");
      expect(resolved?.mediatedAdditions).toEqual([]);
    }
  });

  test("a bundled address is never a mediated addition, whatever the signed copy says", () => {
    const bundledDirect = FLOOR.entries.find((e) => !e.requiresMediator);
    const entries = [
      exchangeEntry(BUNDLED_MEDIATED),
      ...(bundledDirect ? [exchangeEntry(bundledDirect.address)] : []),
    ];
    const resolved = resolveServedRegistry(FLOOR, signed(entries), trust());
    expect(resolved?.mediatedAdditions).toEqual([]);
  });

  test("an added exchange that does not need the intermediary is not a mediated addition", () => {
    const resolved = resolveServedRegistry(
      FLOOR,
      signed([exchangeEntry(ADDED, { requiresMediator: false })]),
      trust()
    );
    expect(resolved?.trust).toBe("signed");
    expect(resolved?.mediatedAdditions).toEqual([]);
  });

  test("a malformed added entry is dropped and never marked", () => {
    const resolved = resolveServedRegistry(
      FLOOR,
      signed([exchangeEntry(ADDED, { network: "mainnet" })]),
      trust()
    );
    expect(resolved?.mediatedAdditions).toEqual([]);
  });

  test("a body that is not a registry resolves to null", () => {
    expect(resolveServedRegistry(FLOOR, { entries: [] }, trust())).toBeNull();
    expect(resolveServedRegistry(FLOOR, null, trust())).toBeNull();
  });
});

describe("mediatedByAddition", () => {
  const entries = [
    exchangeEntry(ADDED),
    exchangeEntry(OTHER, { network: "testnet" }),
  ] as RegistryEntry[];

  test("answers for a marked address on a network it applies on", () => {
    const registry = { entries, mediatedAdditions: [ADDED, OTHER] };
    expect(mediatedByAddition(registry, ADDED, "mainnet")).toBe(true);
    expect(mediatedByAddition(registry, ADDED, "testnet")).toBe(true);
  });

  test("a testnet-scoped addition is not mediated on mainnet", () => {
    const registry = { entries, mediatedAdditions: [ADDED, OTHER] };
    expect(mediatedByAddition(registry, OTHER, "testnet")).toBe(true);
    expect(mediatedByAddition(registry, OTHER, "mainnet")).toBe(false);
  });

  test("an address that is not marked is not mediated", () => {
    expect(mediatedByAddition({ entries, mediatedAdditions: [] }, ADDED, "mainnet")).toBe(false);
    expect(mediatedByAddition({ entries }, ADDED, "mainnet")).toBe(false);
  });

  test("a marked address whose entry no longer needs the intermediary is not mediated", () => {
    const relaxed = [exchangeEntry(ADDED, { requiresMediator: false })] as RegistryEntry[];
    expect(
      mediatedByAddition({ entries: relaxed, mediatedAdditions: [ADDED] }, ADDED, "mainnet")
    ).toBe(false);
  });
});

describe("the registry the web holds", () => {
  const before = activeRegistry();
  afterEach(() => setRegistry(before));

  test("allows the mediated hand-off for a bundled mediated exchange and nothing else by default", () => {
    expect(mediatorAllowedFor(BUNDLED_MEDIATED, "mainnet")).toBe(true);
    expect(mediatorAllowedFor(ADDED, "mainnet")).toBe(false);
  });

  test("allows it for an address a verified signature added, and for no other", () => {
    setRegistry({
      ...before,
      entries: [...before.entries, exchangeEntry(ADDED) as RegistryEntry],
      trust: "signed",
      mediatedAdditions: [ADDED],
    });
    expect(mediatorAllowedFor(ADDED, "mainnet")).toBe(true);
    expect(mediatorAllowedFor(OTHER, "mainnet")).toBe(false);
  });

  test("a listed address that no signature marked is not allowed", () => {
    setRegistry({ ...before, entries: [...before.entries, exchangeEntry(ADDED) as RegistryEntry] });
    expect(mediatorAllowedFor(ADDED, "mainnet")).toBe(false);
  });
});

describe("fetchServedRegistry", () => {
  const respond = (body: unknown) => async () =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  test("a body signed by a key the build does not pin is unsigned and enables nothing", async () => {
    const snapshot = await fetchServedRegistry(respond(signed([exchangeEntry(ADDED)])));
    expect(snapshot?.trust).toBe("unsigned");
    expect(snapshot?.mediatedAdditions).toEqual([]);
    expect(snapshot?.entries.some((e) => e.address === ADDED)).toBe(true);
  });

  test("a body with no signature is unsigned", async () => {
    const snapshot = await fetchServedRegistry(respond(registryBody([exchangeEntry(ADDED)])));
    expect(snapshot?.trust).toBe("unsigned");
  });

  test("the bundled floor reports its own sequence", () => {
    expect(bundledRegistry().trust).toBe("bundled");
    expect(Number.isSafeInteger(bundledRegistry().sequence)).toBe(true);
  });
});

describe("mediatorAllowedUnder", () => {
  test("answers from the bundled registry with no snapshot", () => {
    expect(mediatorAllowedUnder(BUNDLED_MEDIATED, "mainnet")).toBe(true);
    expect(mediatorAllowedUnder(ADDED, "mainnet")).toBe(false);
  });

  test("an unsigned snapshot adds nothing", () => {
    const { signature: _drop, ...bare } = signed([exchangeEntry(ADDED)]);
    expect(
      mediatorAllowedUnder(ADDED, "mainnet", bare as Parameters<typeof mediatorAllowedUnder>[2])
    ).toBe(false);
  });

  test("a snapshot that is not a registry is refused", () => {
    expect(() =>
      mediatorAllowedUnder(ADDED, "mainnet", {} as Parameters<typeof mediatorAllowedUnder>[2])
    ).toThrow("not a registry");
  });
});

describe("pinnedRegistryTrust", () => {
  test("is the pinned keys and the sequence of the bundled registry", () => {
    expect(pinnedRegistryTrust()).toEqual({
      keys: REGISTRY_SIGNING_KEYS,
      bundledSequence: bundledRegistry().sequence,
    });
    expect(pinnedRegistryTrust().keys.length).toBe(2);
  });
});
