import { describe, expect, test } from "bun:test";
import {
  createContractRegistryLookup,
  entriesForNetwork,
  entriesForProtocol,
  isRegistryFresh,
  resolveWasmHash,
  servedContractRegistry,
  validateContractRegistry,
} from "@/lib/contract-registry";
import shippedRegistry from "@/config/contract-registry.json";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
// Real StrKey-checksummed contract addresses (32 zero bytes / 32 0x11 bytes).
const ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ADDRESS_2 = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

type Raw = Record<string, unknown>;

function entry(overrides: Raw = {}): Raw {
  return {
    network: "testnet",
    protocol: "blend",
    kind: "pool",
    address: ADDRESS,
    wasmHash: HASH_A,
    version: "v2",
    label: "Blend V2 test pool",
    verifiedLive: true,
    ...overrides,
  };
}

function wellFormed(entries: Raw[] = [entry()]): Raw {
  return {
    version: "2026-09-01",
    lastVerified: "2026-09-01",
    validUntil: "2026-12-01",
    source: "test",
    entries,
  };
}

function expectRejected(raw: unknown, message: string): void {
  expect(() => validateContractRegistry(raw)).toThrow(message);
}

// ─── The shipped file ────────────────────────────────────────────────────────────────────────

// The community-PR guard: any merged edit to the shipped JSON must still parse. This test is
// what turns a typo'd hash, a checksum-invalid address, or a bad protocol name into a CI failure
// instead of a wrong runtime lookup.
test("the shipped contract-registry.json validates", () => {
  expect(() => validateContractRegistry(shippedRegistry)).not.toThrow();
});

test("serves the registry with its freshness metadata, frozen", () => {
  const registry = servedContractRegistry();
  expect(registry.entries.length).toBeGreaterThan(0);
  expect(typeof registry.lastVerified).toBe("string");
  expect(typeof registry.validUntil).toBe("string");
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Object.isFrozen(registry.entries[0])).toBe(true);
});

test("every protocol with an exit adapter has verified mainnet entries: the runner halts on any hash the registry does not know for the network", () => {
  expect(entriesForNetwork("testnet").length).toBeGreaterThan(0);
  const mainnet = entriesForNetwork("mainnet");
  expect(mainnet.length).toBeGreaterThan(0);
  expect(mainnet.every((e) => e.verifiedLive && e.wasmHash !== null)).toBe(true);
  for (const protocol of ["blend", "aquarius", "soroswap"] as const) {
    const kinds = new Set(entriesForProtocol("mainnet", protocol).map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(0);
    // The kinds an exit calls or reads must be there, not just a reference contract.
    if (protocol === "blend") expect([...kinds].sort()).toEqual(["backstop", "factory", "pool"]);
    if (protocol === "aquarius") expect([...kinds].sort()).toEqual(["pool", "router"]);
    if (protocol === "soroswap") expect([...kinds].sort()).toEqual(["factory", "pair", "router"]);
  }
  // Aquarius pools come in three codes; each has one representative per network.
  expect(
    entriesForProtocol("mainnet", "aquarius")
      .filter((e) => e.kind === "pool")
      .map((e) => e.version)
      .sort()
  ).toEqual(["concentrated", "constant_product", "stable"]);
});

test("filters entries by network and protocol", () => {
  const blend = entriesForProtocol("testnet", "blend");
  expect(blend.length).toBeGreaterThan(0);
  expect(blend.every((e) => e.protocol === "blend")).toBe(true);
});

test("resolves a shipped entry's recorded wasmHash to its protocol version", () => {
  const [firstBlend] = entriesForProtocol("testnet", "blend");
  if (!firstBlend?.wasmHash) throw new Error("expected a Blend entry with a hash");
  expect(resolveWasmHash("testnet", firstBlend.wasmHash)).toEqual({
    status: "known",
    protocol: "blend",
    kind: firstBlend.kind,
    version: firstBlend.version,
    wasmHash: firstBlend.wasmHash,
  });
});

test("an unregistered hash resolves to unknown, never to a guess", () => {
  expect(resolveWasmHash("testnet", HASH_B)).toEqual({ status: "unknown", wasmHash: HASH_B });
});

test("carries a null wasmHash for the documented-but-unresolvable FxDAO entry rather than a guess", () => {
  const fxdao = entriesForProtocol("testnet", "fxdao");
  expect(fxdao.some((e) => e.wasmHash === null && e.verifiedLive === false)).toBe(true);
});

test("today's date is within the registry's verification window", () => {
  expect(isRegistryFresh(new Date())).toBe(true);
});

test("is fail-closed past validUntil", () => {
  const pastValidUntil = new Date(`${servedContractRegistry().validUntil}T23:59:59Z`);
  pastValidUntil.setDate(pastValidUntil.getDate() + 1);
  expect(isRegistryFresh(pastValidUntil)).toBe(false);
});

// ─── The validator ───────────────────────────────────────────────────────────────────────────

describe("validateContractRegistry", () => {
  test("accepts a well-formed registry and returns it deeply frozen", () => {
    const registry = validateContractRegistry(wellFormed());
    expect(registry.entries).toHaveLength(1);
    expect(() => {
      (registry.entries[0] as { protocol: string }).protocol = "soroswap";
    }).toThrow();
    expect(() => {
      (registry.entries as unknown[]).push({});
    }).toThrow();
    expect(registry.entries[0].protocol).toBe("blend");
  });

  test("accepts an optional verifiedBy on an entry", () => {
    const registry = validateContractRegistry(
      wellFormed([entry({ verifiedBy: "stellar contract fetch --id C... | sha256sum" })])
    );
    expect(registry.entries[0].verifiedBy).toContain("sha256sum");
  });

  test("rejects a non-object root", () => {
    expectRejected([], "root must be an object");
  });

  test("rejects a non-array entries collection", () => {
    expectRejected({ ...wellFormed(), entries: "x" }, "entries must be an array");
  });

  test("rejects a missing root field", () => {
    const raw = wellFormed();
    delete raw.source;
    expectRejected(raw, "source must be a non-empty string");
  });

  test.each([
    ["not a date", "yesterday"],
    ["a non-ISO date", "01/09/2026"],
    ["an impossible date", "2026-13-40"],
  ])("rejects lastVerified that is %s", (_label, lastVerified) => {
    expectRejected({ ...wellFormed(), lastVerified }, "lastVerified must be a YYYY-MM-DD date");
  });

  test("rejects a validUntil earlier than lastVerified", () => {
    expectRejected(
      { ...wellFormed(), validUntil: "2026-08-01" },
      "validUntil must not precede lastVerified"
    );
  });

  test("rejects an unrecognized field at every level, so typos cannot ship as ignored data", () => {
    expectRejected({ ...wellFormed(), entrys: [] }, "root.entrys is not a recognized field");
    expectRejected(
      wellFormed([entry({ adress: ADDRESS })]),
      "entries[0].adress is not a recognized field"
    );
  });

  test("rejects a non-object entry", () => {
    expectRejected(wellFormed(["x" as unknown as Raw]), "entries[0] must be an object");
  });

  test.each([
    ["network", "futurenet", "entries[0].network must be one of"],
    ["protocol", "uniswap", "entries[0].protocol must be one of"],
    ["kind", "oracle", "entries[0].kind must be one of"],
  ])("rejects an unknown %s", (field, value, message) => {
    expectRejected(wellFormed([entry({ [field]: value })]), message);
  });

  test.each([
    ["uppercase hex", HASH_A.toUpperCase()],
    ["too short", "abc123"],
    ["non-hex characters", "g".repeat(64)],
    ["0x-prefixed", `0x${"a".repeat(62)}`],
  ])("rejects a wasmHash that is %s", (_label, wasmHash) => {
    expectRejected(
      wellFormed([entry({ wasmHash })]),
      "entries[0].wasmHash must be 64 lowercase hex characters, or null"
    );
  });

  test("rejects a non-string, non-null wasmHash", () => {
    expectRejected(
      wellFormed([entry({ wasmHash: 42 })]),
      "entries[0].wasmHash must be a non-empty string"
    );
  });

  test("accepts a null wasmHash only for an entry that did not resolve live", () => {
    expect(() =>
      validateContractRegistry(wellFormed([entry({ wasmHash: null, verifiedLive: false })]))
    ).not.toThrow();
    expectRejected(
      wellFormed([entry({ wasmHash: null, verifiedLive: true })]),
      "entries[0].wasmHash cannot be null when verifiedLive is true"
    );
  });

  test("rejects a non-boolean verifiedLive", () => {
    expectRejected(
      wellFormed([entry({ verifiedLive: "yes" })]),
      "entries[0].verifiedLive must be a boolean"
    );
  });

  test("rejects a shape-valid address whose StrKey checksum is wrong - a transposed character", () => {
    expectRejected(
      wellFormed([entry({ address: `C${"A".repeat(55)}` })]),
      "entries[0].address must be a valid C... contract address"
    );
  });

  test("rejects an account (G...) address where a contract is required", () => {
    expectRejected(
      wellFormed([entry({ address: `G${"A".repeat(55)}` })]),
      "entries[0].address must be a valid C... contract address"
    );
  });

  test("rejects the same address listed twice for one network", () => {
    expectRejected(
      wellFormed([entry(), entry({ kind: "router" })]),
      `duplicate address testnet:${ADDRESS}`
    );
  });

  test("allows the same address on two networks and the same hash on many instances", () => {
    const registry = validateContractRegistry(
      wellFormed([
        entry(),
        entry({ network: "mainnet" }),
        entry({ address: ADDRESS_2, label: "a second pool from the same factory" }),
      ])
    );
    expect(registry.entries).toHaveLength(3);
  });

  test("rejects one hash mapped to conflicting protocol versions", () => {
    expectRejected(
      wellFormed([entry(), entry({ address: ADDRESS_2, version: "v3" })]),
      `wasmHash ${HASH_A} maps to conflicting protocol versions`
    );
    expectRejected(
      wellFormed([entry(), entry({ address: ADDRESS_2, protocol: "soroswap", kind: "pair" })]),
      `wasmHash ${HASH_A} maps to conflicting protocol versions`
    );
  });

  test("rejects whitespace-only strings - a single space is not a label or provenance", () => {
    expectRejected(wellFormed([entry({ label: "  " })]), "entries[0].label must be a non-empty");
    expectRejected(
      wellFormed([entry({ verifiedBy: " " })]),
      "entries[0].verifiedBy must be a non-empty string"
    );
  });

  test("rejects a field beyond the length cap", () => {
    expectRejected(
      wellFormed([entry({ label: "x".repeat(501) })]),
      "entries[0].label must be at most 500 characters"
    );
  });
});

// ─── The lookup, over a populated fixture ────────────────────────────────────────────────────

describe("createContractRegistryLookup", () => {
  const lookup = createContractRegistryLookup(
    validateContractRegistry(
      wellFormed([
        entry(),
        entry({ address: ADDRESS_2, label: "second Blend pool, same code" }),
        entry({
          network: "mainnet",
          protocol: "soroswap",
          kind: "pair",
          address: ADDRESS_2,
          wasmHash: HASH_B,
          version: "v1",
          label: "Soroswap pair",
        }),
      ])
    )
  );

  test("a registered hash resolves to its protocol version on the network it was verified for", () => {
    expect(lookup.resolveWasmHash("testnet", HASH_A)).toEqual({
      status: "known",
      protocol: "blend",
      kind: "pool",
      version: "v2",
      wasmHash: HASH_A,
    });
  });

  test("the same hash is unknown on a network nobody verified it for", () => {
    expect(lookup.resolveWasmHash("mainnet", HASH_A)).toEqual({
      status: "unknown",
      wasmHash: HASH_A,
    });
    expect(lookup.resolveWasmHash("mainnet", HASH_B).status).toBe("known");
    expect(lookup.resolveWasmHash("testnet", HASH_B).status).toBe("unknown");
  });

  test("normalization maps a mixed-case, padded read onto the known entry", () => {
    expect(lookup.resolveWasmHash("testnet", `  ${HASH_A.toUpperCase()}  `).status).toBe("known");
  });

  test("a non-string or malformed hash resolves to unknown rather than throwing mid-plan", () => {
    expect(lookup.resolveWasmHash("testnet", undefined as unknown as string)).toEqual({
      status: "unknown",
      wasmHash: "",
    });
    expect(lookup.resolveWasmHash("testnet", "not-a-hash").status).toBe("unknown");
  });

  test("entriesForNetwork and entriesForProtocol filter as named", () => {
    expect(lookup.entriesForNetwork("testnet").map((e) => e.address)).toEqual([ADDRESS, ADDRESS_2]);
    expect(lookup.entriesForNetwork("mainnet").map((e) => e.protocol)).toEqual(["soroswap"]);
    expect(lookup.entriesForProtocol("testnet", "blend")).toHaveLength(2);
    expect(lookup.entriesForProtocol("testnet", "phoenix")).toEqual([]);
  });

  test("isRegistryFresh follows the fixture's own validUntil", () => {
    expect(lookup.isRegistryFresh(new Date("2026-12-01T12:00:00Z"))).toBe(true);
    expect(lookup.isRegistryFresh(new Date("2026-12-02T00:00:00Z"))).toBe(false);
  });
});
