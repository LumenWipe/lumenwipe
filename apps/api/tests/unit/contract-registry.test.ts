import { describe, expect, test } from "bun:test";
import {
  createContractRegistryLookup,
  entriesForNetwork,
  entriesForProtocol,
  isRegistryFresh,
  isExitCapable,
  resolveCode,
  servedContractRegistry,
  soroswapConversionContracts,
  staleEntries,
  staleEntryWarnings,
  validateContractRegistry,
} from "@/lib/contract-registry";
import { FXDAO_REPAY_VERSION } from "@/lib/defi-exits/fxdao";
import { PHOENIX_BLENDED_VERSION } from "@/lib/defi-exits/phoenix";
import shippedRegistry from "@/config/contract-registry.json";
import { StrKey } from "@stellar/stellar-sdk";
import type { CodeIdentity } from "@/lib/stellar/contract-instance";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
// Real StrKey-checksummed contract addresses (32 zero bytes / 32 0x11 bytes).
const ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ADDRESS_2 = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

type Raw = Record<string, unknown>;

const wasm = (wasmHash: string): CodeIdentity => ({ kind: "wasm", wasmHash });

// What every mainnet entry must carry: how, where and when its hash was checked.
const PROVENANCE: Raw = {
  verifiedBy: "stellar contract info hash --id C... --network mainnet",
  source: "the protocol's published mainnet contracts file",
  verifiedAt: "2026-09-01",
};

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

test("every protocol with a working exit adapter has verified mainnet entries: the runner halts on any hash the registry does not know for the network", () => {
  expect(entriesForNetwork("testnet").length).toBeGreaterThan(0);
  const mainnet = entriesForNetwork("mainnet");
  expect(mainnet.length).toBeGreaterThan(0);
  // Every mainnet entry resolves; FxDAO's vault does too, but runs a no-exit version (see the
  // dedicated test below), so it backs no exit.
  expect(mainnet.every((e) => e.verifiedLive && e.wasmHash !== null)).toBe(true);
  for (const protocol of ["blend", "aquarius", "soroswap", "phoenix"] as const) {
    const kinds = new Set(entriesForProtocol("mainnet", protocol).map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(0);
    // The kinds an exit calls or reads must be there, not just a reference contract.
    if (protocol === "blend") expect([...kinds].sort()).toEqual(["backstop", "factory", "pool"]);
    if (protocol === "aquarius") expect([...kinds].sort()).toEqual(["pool", "router"]);
    if (protocol === "soroswap")
      expect([...kinds].sort()).toEqual(["aggregator", "factory", "pair", "router"]);
    if (protocol === "phoenix") expect([...kinds].sort()).toEqual(["pool", "stake"]);
  }
  // Blend V2 ships the same code on both networks; the labels say so, so the file must agree.
  for (const kind of ["factory", "backstop", "pool"] as const) {
    const on = (network: "testnet" | "mainnet") =>
      entriesForProtocol(network, "blend").find((e) => e.kind === kind && e.version === "v2")!
        .wasmHash;
    expect(on("mainnet")).toBe(on("testnet"));
  }
  // Aquarius pools come in three codes; each has one representative per network.
  expect(
    entriesForProtocol("mainnet", "aquarius")
      .filter((e) => e.kind === "pool")
      .map((e) => e.version)
      .sort()
  ).toEqual(["concentrated", "constant_product", "stable"]);
});

test("mainnet Blend and Phoenix pools listed by address all run a pool code already registered for that protocol", () => {
  for (const [protocol, codes] of [
    ["blend", 2],
    ["phoenix", 4],
  ] as const) {
    const pools = entriesForProtocol("mainnet", protocol).filter((e) => e.kind === "pool");
    expect(pools.length).toBeGreaterThan(codes);
    expect(new Set(pools.map((e) => e.wasmHash)).size).toBe(codes);
  }
});

test("every mainnet Phoenix pool's stake contract is listed, so a staked position in any of them can unbond", () => {
  const phoenix = entriesForProtocol("mainnet", "phoenix");
  const pools = phoenix.filter((e) => e.kind === "pool" && e.version !== PHOENIX_BLENDED_VERSION);
  const stakes = phoenix.filter((e) => e.kind === "stake");
  expect(stakes.length).toBe(pools.length);
  expect(new Set(stakes.map((e) => e.address)).size).toBe(stakes.length);
  const representatives = stakes.filter((e) => !pools.some((p) => e.label.includes(p.address)));
  expect(representatives.map((e) => e.address).sort()).toEqual([
    "CDBMVFP7KJXW3YEFSLOU5GYUQHHJJI7QPZJPCSPDK6HHBCBZAMCHS2QY",
    "CDOXQONPND365K6MHR3QBSVVTC3MKR44ORK6TI2GQXUXGGAS5SNDAYRI",
  ]);
  const covered = pools.filter(
    (p) => stakes.filter((e) => e.label.includes(p.address)).length === 1
  );
  expect(covered.length).toBe(pools.length - representatives.length);
});

test("the testnet Phoenix pool and stake run a code a verifiedLive mainnet pool and stake run, under the same version", () => {
  const mainnet = entriesForProtocol("mainnet", "phoenix").filter((e) => e.verifiedLive);
  const testnet = entriesForProtocol("testnet", "phoenix").filter(
    (e) => e.kind === "pool" || e.kind === "stake"
  );
  expect(testnet.map((e) => e.kind).sort()).toEqual(["pool", "stake"]);
  for (const entry of testnet) {
    const same = mainnet.filter((e) => e.kind === entry.kind && e.wasmHash === entry.wasmHash);
    expect(same.length, entry.address).toBeGreaterThan(0);
    expect(new Set(same.map((e) => e.version)), entry.address).toEqual(new Set([entry.version]));
  }
});

test("a blended Phoenix pool has no staking, so no stake entry names it and it is never a stake", () => {
  const phoenix = entriesForProtocol("mainnet", "phoenix");
  const blended = phoenix.filter((e) => e.version === PHOENIX_BLENDED_VERSION);
  expect(blended.map((e) => `${e.kind}:${e.address}`)).toEqual([
    "pool:CBENABXP6C4C7WG6KB7JQOTDS5GIIXF3IX3PIYNZFCDZDWUHITO2HZ4S",
  ]);
  const stakes = phoenix.filter((e) => e.kind === "stake");
  for (const pool of blended) {
    expect(
      stakes.filter((e) => e.address === pool.address || e.label.includes(pool.address))
    ).toEqual([]);
  }
});

test("filters entries by network and protocol", () => {
  const blend = entriesForProtocol("testnet", "blend");
  expect(blend.length).toBeGreaterThan(0);
  expect(blend.every((e) => e.protocol === "blend")).toBe(true);
});

test("resolves a shipped entry's recorded wasmHash to its protocol version", () => {
  const [firstBlend] = entriesForProtocol("testnet", "blend");
  if (!firstBlend?.wasmHash) throw new Error("expected a Blend entry with a hash");
  expect(resolveCode("testnet", wasm(firstBlend.wasmHash))).toEqual({
    status: "known",
    protocol: "blend",
    kind: firstBlend.kind,
    version: firstBlend.version,
    wasmHash: firstBlend.wasmHash,
  });
});

test("an unregistered hash resolves to unknown, never to a guess", () => {
  expect(resolveCode("testnet", wasm(HASH_B))).toEqual({ status: "unknown", wasmHash: HASH_B });
});

test("the testnet FxDAO vault is our own reference redeploy of FxDAO's real code, not a guess", () => {
  // FxDAO's own testnet and mainnet vaults are both confirmed unusable (see the mainnet test
  // below), so testnet carries our own build of FxDAO's real open-source contract instead of a
  // null placeholder - the same reason Phoenix's testnet factory/router/pool/stake entries exist.
  const fxdao = entriesForProtocol("testnet", "fxdao");
  expect(fxdao).toHaveLength(1);
  expect(fxdao[0]).toMatchObject({ kind: "vault", verifiedLive: true });
  expect(fxdao[0]!.wasmHash).not.toBeNull();
});

test("the mainnet FxDAO vault is pinned to its live code as a no-exit version, recognized and never exit-capable", () => {
  const fxdao = entriesForProtocol("mainnet", "fxdao");
  expect(fxdao).toHaveLength(1);
  const vault = fxdao[0]!;
  expect(vault).toMatchObject({
    kind: "vault",
    address: "CCUN4RXU5VNDHSF4S4RKV4ZJYMX2YWKOH6L4AKEKVNVDQ7HY5QIAO4UB",
    wasmHash: "0245bac3d0ada657e247346273316c22b106c113f2085dbbc2c46faa0c28d498",
    version: "wind-down",
    // Verified live, so the mainnet canary keeps re-reading its hash.
    verifiedLive: true,
  });
  expect(vault.verifiedBy).toContain("2026-11-08");
  expect(resolveCode("mainnet", wasm(vault.wasmHash!))).toEqual({
    status: "known",
    protocol: "fxdao",
    kind: "vault",
    version: "wind-down",
    wasmHash: vault.wasmHash!,
  });
  expect(servedContractRegistry().noExitVersions).toEqual({ fxdao: ["wind-down"] });
  expect(isExitCapable(vault)).toBe(false);
  // The adapter only repays on the version it was verified on, which is exit-capable.
  expect(vault.version).not.toBe(FXDAO_REPAY_VERSION);
  expect(entriesForProtocol("testnet", "fxdao").map((e) => [e.version, isExitCapable(e)])).toEqual([
    [FXDAO_REPAY_VERSION, true],
  ]);
});

test("every shipped mainnet entry records how, where and when it was verified, never before the file's last full re-verification", () => {
  const { lastVerified, entries } = servedContractRegistry();
  const mainnet = entries.filter((e) => e.network === "mainnet");
  expect(mainnet.length).toBeGreaterThan(0);
  for (const e of mainnet) {
    expect(e.verifiedBy, e.address).toBeString();
    expect(e.source, e.address).toBeString();
    expect(e.verifiedAt! >= lastVerified, e.address).toBe(true);
    expect(e.ownDeployment, e.address).toBeUndefined();
  }
});

test("the testnet contracts LumenWipe deployed itself are marked, and only those", () => {
  const own = servedContractRegistry()
    .entries.filter((e) => e.ownDeployment)
    .map((e) => `${e.network}:${e.protocol}:${e.kind}:${e.address}`);
  expect(own.sort()).toEqual(
    [
      "testnet:fxdao:vault:CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N",
      "testnet:phoenix:factory:CB7UHVINMUGNHPEFSJYTIIF67ETZAOCVHTBY7XFN5TVKNAWOMVNYIIWW",
      "testnet:phoenix:router:CDQM2A7B5ZJIR5DEQF7Q63PWU2EWEJ2KXU5IPN5GY3DR67M2SLQMO7B3",
      "testnet:phoenix:pool:CA4V7YVUC3EE2EFVTEYJ47ZD34K4DCAKEYV6AHRR73KTKO5GDGNZLLMT",
      "testnet:phoenix:stake:CBYFZPJ2DP5IK74JOXUPUM2RAM7N42OVOLK7K5UOIK7QQQKQTN2PZJWU",
    ].sort()
  );
});

const XBULL_ROUTER = "CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT";
// The router's code since its 2026-11-16 upgrade (ledger 65514477), and the code it replaced.
const XBULL_ROUTER_HASH = "e2acb145fa324907437321dd2d1ad0d51e5dd5f07bf31f25f89bf30896a95e31";
const XBULL_ROUTER_RETIRED_HASH =
  "c2b3ec57fbd45d5bade9df2ad30c464d1588cead18495a5ce327a98c45c02219";

test("resolves the xBull mainnet router by its live wasm hash", () => {
  const lookup = createContractRegistryLookup(
    validateContractRegistry({
      version: "test",
      lastVerified: "2026-01-01",
      validUntil: "2099-01-01",
      source: "test",
      entries: [
        {
          network: "mainnet",
          protocol: "xbull",
          kind: "router",
          address: XBULL_ROUTER,
          wasmHash: XBULL_ROUTER_HASH,
          version: "v1",
          label: "xBull PathPayment swap router",
          verifiedLive: true,
          ...PROVENANCE,
        },
      ],
    })
  );
  expect(lookup.resolveCode("mainnet", wasm(XBULL_ROUTER_HASH))).toMatchObject({
    status: "known",
    protocol: "xbull",
    kind: "router",
  });
});

test("the shipped mainnet xBull router is pinned to its upgraded code alone, and the retired code is unknown", () => {
  const [router, ...others] = entriesForProtocol("mainnet", "xbull");
  expect(others).toEqual([]);
  expect(router).toMatchObject({ address: XBULL_ROUTER, wasmHash: XBULL_ROUTER_HASH });
  expect(isExitCapable(router!)).toBe(true);
  expect(resolveCode("mainnet", wasm(XBULL_ROUTER_HASH))).toMatchObject({
    status: "known",
    protocol: "xbull",
    kind: "router",
  });
  expect(resolveCode("mainnet", wasm(XBULL_ROUTER_RETIRED_HASH))).toEqual({
    status: "unknown",
    wasmHash: XBULL_ROUTER_RETIRED_HASH,
  });
});

const SOROSWAP_AGGREGATOR = "CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4";
// The aggregator's code since its 2026-11-23 upgrade (ledger 65628395), and the code it replaced.
const SOROSWAP_AGGREGATOR_HASH = "72138d720c2d89831906a5f6e88dcf832abda02125fa32e9f0ebf1714041901f";
const SOROSWAP_AGGREGATOR_RETIRED_HASH =
  "437653282e9c93b0b4d736d8fde01bf002adefb61bfb75917e609f5336ee3190";

test("the shipped mainnet Soroswap aggregator is pinned to its upgraded code alone, and the retired code is unknown", () => {
  const [aggregator, ...others] = entriesForProtocol("mainnet", "soroswap").filter(
    (e) => e.kind === "aggregator"
  );
  expect(others).toEqual([]);
  expect(aggregator).toMatchObject({
    address: SOROSWAP_AGGREGATOR,
    wasmHash: SOROSWAP_AGGREGATOR_HASH,
  });
  expect(soroswapConversionContracts("mainnet").aggregator).toEqual([SOROSWAP_AGGREGATOR]);
  expect(resolveCode("mainnet", wasm(SOROSWAP_AGGREGATOR_HASH))).toMatchObject({
    status: "known",
    protocol: "soroswap",
    kind: "aggregator",
  });
  expect(resolveCode("mainnet", wasm(SOROSWAP_AGGREGATOR_RETIRED_HASH))).toEqual({
    status: "unknown",
    wasmHash: SOROSWAP_AGGREGATOR_RETIRED_HASH,
  });
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

  test.each([["verifiedBy"], ["source"], ["verifiedAt"]])(
    "rejects a mainnet entry without %s",
    (field) => {
      const raw = entry({ network: "mainnet", ...PROVENANCE });
      delete raw[field];
      expectRejected(wellFormed([raw]), `entries[0].${field} must be a non-empty string`);
    }
  );

  test("accepts a testnet entry without verifiedBy, source or verifiedAt, and keeps them when given", () => {
    expect(() => validateContractRegistry(wellFormed([entry()]))).not.toThrow();
    const registry = validateContractRegistry(wellFormed([entry(PROVENANCE)]));
    expect(registry.entries[0]).toMatchObject(PROVENANCE);
  });

  test.each([
    ["not a date", "last week"],
    ["a timestamp", "2026-09-01T00:00:00Z"],
    ["not zero-padded", "2026-9-01"],
  ])("rejects a verifiedAt that is %s", (_label, verifiedAt) => {
    expectRejected(
      wellFormed([entry({ network: "mainnet", ...PROVENANCE, verifiedAt })]),
      "entries[0].verifiedAt must be a YYYY-MM-DD date"
    );
  });

  test("rejects a verifiedAt earlier than lastVerified, on either network: a full re-verification checks every entry", () => {
    for (const network of ["mainnet", "testnet"]) {
      expectRejected(
        wellFormed([entry({ network, ...PROVENANCE, verifiedAt: "2026-08-31" })]),
        "entries[0].verifiedAt must not precede lastVerified"
      );
    }
    expect(() =>
      validateContractRegistry(
        wellFormed([entry({ network: "mainnet", ...PROVENANCE, verifiedAt: "2026-09-01" })])
      )
    ).not.toThrow();
  });

  test("ownDeployment marks a testnet entry with its verifiedBy, and nothing else", () => {
    const own = validateContractRegistry(
      wellFormed([entry({ ownDeployment: true, verifiedBy: "stellar contract deploy ..." })])
    );
    expect(own.entries[0].ownDeployment).toBe(true);
    expectRejected(
      wellFormed([entry({ network: "mainnet", ...PROVENANCE, ownDeployment: true })]),
      "entries[0].ownDeployment is allowed only on testnet"
    );
    expectRejected(
      wellFormed([entry({ ownDeployment: "yes", verifiedBy: "x" })]),
      "entries[0].ownDeployment must be true when present"
    );
    expectRejected(
      wellFormed([entry({ ownDeployment: false, verifiedBy: "x" })]),
      "entries[0].ownDeployment must be true when present"
    );
    expectRejected(
      wellFormed([entry({ ownDeployment: true })]),
      "entries[0].verifiedBy is required on an entry LumenWipe deployed itself"
    );
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

  test("noExitVersions: absent means none; listed versions make an entry not exit-capable", () => {
    const fx = entry({ protocol: "fxdao", kind: "vault", version: "wind-down", wasmHash: HASH_B });
    expect(validateContractRegistry(wellFormed([fx])).noExitVersions).toEqual({});
    expect(
      createContractRegistryLookup(validateContractRegistry(wellFormed([fx]))).isExitCapable(
        validateContractRegistry(wellFormed([fx])).entries[0]!
      )
    ).toBe(true);
    const listed = validateContractRegistry({
      ...wellFormed([fx, entry({ address: ADDRESS_2, version: "wind-down" })]),
      noExitVersions: { fxdao: ["wind-down"] },
    });
    expect(Object.isFrozen(listed.noExitVersions)).toBe(true);
    expect(Object.isFrozen(listed.noExitVersions.fxdao)).toBe(true);
    const lookup = createContractRegistryLookup(listed);
    expect(lookup.isExitCapable(listed.entries[0]!)).toBe(false);
    // Another protocol's entry on the same version name is untouched.
    expect(lookup.isExitCapable(listed.entries[1]!)).toBe(true);
    // A hash-less or not-live entry is never exit-capable either.
    const unresolved = validateContractRegistry(
      wellFormed([
        entry({ wasmHash: null, verifiedLive: false }),
        entry({ address: ADDRESS_2, verifiedLive: false }),
      ])
    );
    const unresolvedLookup = createContractRegistryLookup(unresolved);
    expect(unresolved.entries.map((e) => unresolvedLookup.isExitCapable(e))).toEqual([
      false,
      false,
    ]);
  });

  test("noExitVersions: rejects a non-object, an unknown protocol, a non-array, a blank or an unused version", () => {
    const fx = entry({ protocol: "fxdao", kind: "vault", version: "wind-down" });
    const withList = (noExitVersions: unknown) => ({ ...wellFormed([fx]), noExitVersions });
    expectRejected(withList(["wind-down"]), "noExitVersions must be an object");
    expectRejected(
      withList({ fxdoa: ["wind-down"] }),
      "noExitVersions.fxdoa is not a recognized protocol"
    );
    expectRejected(
      withList({ fxdao: "wind-down" }),
      "noExitVersions.fxdao must be an array of versions"
    );
    expectRejected(
      withList({ fxdao: [" "] }),
      "noExitVersions.fxdao[0] must be a non-empty string"
    );
    expectRejected(
      withList({ fxdao: ["wind-dwon"] }),
      "noExitVersions.fxdao[0] names a version no fxdao entry runs"
    );
    // The version must be run by an entry of that same protocol.
    expectRejected(
      {
        ...wellFormed([entry({ version: "wind-down" })]),
        noExitVersions: { fxdao: ["wind-down"] },
      },
      "noExitVersions.fxdao[0] names a version no fxdao entry runs"
    );
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
        entry({ network: "mainnet", ...PROVENANCE }),
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

// ─── Staleness ───────────────────────────────────────────────────────────────────────────────

describe("staleEntries", () => {
  const registry = validateContractRegistry(
    wellFormed([
      entry({ network: "mainnet", ...PROVENANCE, verifiedAt: "2026-09-01" }),
      entry({ network: "mainnet", ...PROVENANCE, address: ADDRESS_2, verifiedAt: "2026-09-02" }),
      entry(),
    ])
  );
  const at = (day: string) => new Date(`${day}T15:00:00Z`);

  test("lists an entry only once it is more than 60 days old", () => {
    expect(staleEntries(registry, at("2026-10-31"))).toHaveLength(0);
    expect(staleEntries(registry, at("2026-11-01")).map((e) => e.address)).toEqual([ADDRESS]);
    expect(staleEntries(registry, at("2026-11-02"))).toHaveLength(2);
  });

  test("counts whole UTC days, whatever the time of day", () => {
    expect(staleEntries(registry, new Date("2026-10-31T23:59:59Z"))).toHaveLength(0);
    expect(staleEntries(registry, new Date("2026-11-01T00:00:00Z"))).toHaveLength(1);
  });

  test("never lists an entry without a date", () => {
    const listed = staleEntries(registry, at("2030-01-01"));
    expect(listed.every((e) => e.verifiedAt !== undefined)).toBe(true);
    expect(listed).toHaveLength(2);
  });

  test("emits one GitHub warning line per stale entry", () => {
    expect(staleEntryWarnings(registry, at("2026-11-01"))).toEqual([
      "::warning title=Contract registry entry not re-verified in 60 days::" +
        `mainnet blend pool ${ADDRESS} was last verified 2026-09-01`,
    ]);
    expect(staleEntryWarnings(registry, at("2026-10-31"))).toEqual([]);
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
          ...PROVENANCE,
        }),
      ])
    )
  );

  test("a registered hash resolves to its protocol version on the network it was verified for", () => {
    expect(lookup.resolveCode("testnet", wasm(HASH_A))).toEqual({
      status: "known",
      protocol: "blend",
      kind: "pool",
      version: "v2",
      wasmHash: HASH_A,
    });
  });

  test("the same hash is unknown on a network nobody verified it for", () => {
    expect(lookup.resolveCode("mainnet", wasm(HASH_A))).toEqual({
      status: "unknown",
      wasmHash: HASH_A,
    });
    expect(lookup.resolveCode("mainnet", wasm(HASH_B)).status).toBe("known");
    expect(lookup.resolveCode("testnet", wasm(HASH_B)).status).toBe("unknown");
  });

  test("normalization maps a mixed-case, padded read onto the known entry", () => {
    expect(lookup.resolveCode("testnet", wasm(`  ${HASH_A.toUpperCase()}  `)).status).toBe("known");
  });

  test("a non-string or malformed hash resolves to unknown rather than throwing mid-plan", () => {
    expect(lookup.resolveCode("testnet", wasm(undefined as unknown as string))).toEqual({
      status: "unknown",
      wasmHash: "",
    });
    expect(lookup.resolveCode("testnet", wasm("not-a-hash")).status).toBe("unknown");
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

// ─── CAP-85 external references ──────────────────────────────────────────────────────────────

describe("an entry pinned to an external reference", () => {
  const OWNER = StrKey.encodeContract(Buffer.alloc(32, 0x22));
  const OTHER_OWNER = ADDRESS_2;
  const pinned = (overrides: Raw = {}): Raw =>
    entry({
      protocol: "aquarius",
      version: "constant_product",
      label: "Aquarius pool on a shared release",
      executableOwner: OWNER,
      executableTag: "amm.constant",
      ...overrides,
    });
  const ref = (owner: string, tag: string, wasmHash = HASH_A): CodeIdentity => ({
    kind: "external-ref",
    owner,
    tag,
    wasmHash,
  });

  test("validates with its owner, tag and the hash the tag names", () => {
    expect(() => validateContractRegistry(wellFormed([pinned()]))).not.toThrow();
    expect(() =>
      validateContractRegistry(
        wellFormed([
          pinned(),
          entry({
            protocol: "aquarius",
            kind: "executable-owner",
            address: OWNER,
            wasmHash: HASH_B,
            version: "v1",
            label: "release owner",
          }),
        ])
      )
    ).not.toThrow();
  });

  test("the release owner is verified like any entry but is never a contract an exit may touch", () => {
    const registry = validateContractRegistry(
      wellFormed([
        entry({
          protocol: "aquarius",
          kind: "executable-owner",
          address: OWNER,
          version: "v1",
          label: "release owner",
        }),
      ])
    );
    const owner = registry.entries[0]!;
    expect(createContractRegistryLookup(registry).isExitCapable(owner)).toBe(false);
  });

  test("an owner without a tag, or a tag without an owner, is rejected", () => {
    expectRejected(
      wellFormed([pinned({ executableTag: undefined })]),
      "entries[0] must set executableOwner and executableTag together"
    );
    expectRejected(
      wellFormed([pinned({ executableOwner: undefined })]),
      "entries[0] must set executableOwner and executableTag together"
    );
  });

  test("the owner must be a checksummed contract and the pin needs a hash to compare against", () => {
    expectRejected(
      wellFormed([pinned({ executableOwner: "CNOTACONTRACT" })]),
      "entries[0].executableOwner must be a valid C... contract address"
    );
    expectRejected(
      wellFormed([pinned({ wasmHash: null, verifiedLive: false })]),
      "entries[0].executableOwner needs the wasmHash its tag names"
    );
    expectRejected(
      wellFormed([pinned({ executableTag: " " })]),
      "entries[0].executableTag must be a non-empty string"
    );
  });

  test("one hash pinned on one network and carried as plain Wasm on the same network is rejected", () => {
    expectRejected(
      wellFormed([
        pinned(),
        entry({ address: ADDRESS_2, protocol: "aquarius", version: "constant_product" }),
      ]),
      `wasmHash ${HASH_A} maps to conflicting executable references`
    );
  });

  test("one hash pinned to two different references on the same network is rejected", () => {
    expectRejected(
      wellFormed([pinned(), pinned({ address: ADDRESS_2, executableTag: "amm.other" })]),
      `wasmHash ${HASH_A} maps to conflicting executable references`
    );
    expectRejected(
      wellFormed([pinned(), pinned({ address: ADDRESS_2, executableOwner: OTHER_OWNER })]),
      `wasmHash ${HASH_A} maps to conflicting executable references`
    );
  });

  test("the same hash may be pinned on one network and plain Wasm on another", () => {
    expect(() =>
      validateContractRegistry(
        wellFormed([
          pinned(),
          entry({
            network: "mainnet",
            protocol: "aquarius",
            version: "constant_product",
            ...PROVENANCE,
          }),
        ])
      )
    ).not.toThrow();
  });

  describe("resolveCode", () => {
    const lookup = createContractRegistryLookup(validateContractRegistry(wellFormed([pinned()])));

    test("resolves the pinned owner and tag naming the pinned hash", () => {
      expect(lookup.resolveCode("testnet", ref(OWNER, "amm.constant"))).toEqual({
        status: "known",
        protocol: "aquarius",
        kind: "pool",
        version: "constant_product",
        wasmHash: HASH_A,
      });
    });

    test("never falls back to a hash-only match: a wrong owner or tag is unknown", () => {
      expect(lookup.resolveCode("testnet", ref(OTHER_OWNER, "amm.constant")).status).toBe(
        "unknown"
      );
      expect(lookup.resolveCode("testnet", ref(OWNER, "amm.stable")).status).toBe("unknown");
    });

    test("the pinned reference resolving to another hash is unknown", () => {
      expect(lookup.resolveCode("testnet", ref(OWNER, "amm.constant", HASH_B)).status).toBe(
        "unknown"
      );
    });

    test("the pinned hash carried by the instance itself is refused, not taken as the release", () => {
      expect(lookup.resolveCode("testnet", wasm(HASH_A)).status).toBe("unknown");
    });

    test("an external reference to an unpinned entry's hash is refused", () => {
      const plain = createContractRegistryLookup(validateContractRegistry(wellFormed([entry()])));
      expect(plain.resolveCode("testnet", wasm(HASH_A)).status).toBe("known");
      expect(plain.resolveCode("testnet", ref(OWNER, "amm.constant")).status).toBe("unknown");
    });
  });
});

test("the shipped testnet Aquarius pools are pinned to the release owner the registry also verifies", () => {
  const aquarius = entriesForProtocol("testnet", "aquarius");
  const owner = aquarius.find((e) => e.kind === "executable-owner");
  expect(owner?.wasmHash).not.toBeNull();
  const pools = aquarius.filter((e) => e.kind === "pool");
  expect(pools.length).toBe(3);
  for (const pool of pools) expect(pool.executableOwner).toBe(owner!.address);
});
