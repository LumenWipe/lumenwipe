/**
 * Allowance discovery (#162, architecture.md §12): the amount always comes from a live
 * `allowance(from, spender)` read, never from an `approve` event's own data - only the
 * expiration ledger, which SEP-41's `allowance()` cannot return, comes from the event.
 */
import { expect, test } from "bun:test";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { discoverAllowances } from "@/lib/stellar/allowances";
import { fakeAllowancesDeps, OWNER } from "./fixtures/fake-allowances";
import type { ContractRegistryEntry } from "@/lib/contract-registry";

/** A checksum-valid `C...` contract address, deterministic per `seed` - `PairCandidates` rejects
 *  anything that fails `StrKey.isValidContract`, so a fabricated string with the right length but
 *  no real checksum would be silently dropped rather than exercising the cap. */
function contractAddress(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed % 256));
}

const TOKEN = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";
const SPENDER = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const OTHER_TOKEN = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F";
const OTHER_SPENDER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";

function registryEntry(over: Partial<ContractRegistryEntry> = {}): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "blend",
    kind: "pool",
    address: SPENDER,
    wasmHash: "a".repeat(64),
    version: "v2",
    label: "test pool",
    verifiedLive: true,
    ...over,
  };
}

test("discoverAllowances › a live, non-zero allowance found via an approve event is reported with the event's expiration", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [
        { token: TOKEN, spender: SPENDER, amount: 5_000_000n, symbol: "XTAR", decimals: 7 },
      ],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 5_000_000n,
            expirationLedger: 1_100_000,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]).toMatchObject({
    token: TOKEN,
    tokenSymbol: "XTAR",
    tokenDecimals: 7,
    spender: SPENDER,
    spenderProtocol: null,
    amount: "5000000",
    expirationLedger: 1_100_000,
    sources: ["events"],
  });
});

test("discoverAllowances › a revoked allowance (live read zero) is not reported even though an approve event exists", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 0n }],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 5_000_000n,
            expirationLedger: 1_100_000,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(0);
});

test("discoverAllowances › the most recent approve event's expiration wins over an earlier one for the same pair, by ledger not by processing order", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 1_000n, symbol: "XTAR" }],
      events: {
        // The higher-ledger (later) event is listed FIRST here, out of chronological order -
        // this only passes if the implementation tracks the max ledger seen, not "whichever
        // event this pair's entry was set from last while iterating the array".
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 998_500,
            amount: 1_000n,
            expirationLedger: 1_200_000,
          },
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 997_000,
            amount: 9_000_000n,
            expirationLedger: 999_999,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]!.amount).toBe("1000"); // the live read, not either event's amount
  expect(result.allowances[0]!.expirationLedger).toBe(1_200_000); // the higher-ledger event's
});

test("discoverAllowances › a pair only found via the registry (no approve event) is reported with a null expiration and its resolved protocol", async () => {
  const deps = fakeAllowancesDeps({
    world: { allowances: [{ token: TOKEN, spender: SPENDER, amount: 42n, symbol: "XTAR" }] },
    registryEntries: [registryEntry({ address: SPENDER, protocol: "blend", kind: "pool" })],
    knownTokens: [TOKEN],
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]).toMatchObject({
    token: TOKEN,
    spender: SPENDER,
    spenderProtocol: "blend",
    amount: "42",
    expirationLedger: null,
    sources: ["registry"],
  });
});

test("discoverAllowances › the same pair found by both an event and the registry keeps the event's expiration and lists both sources", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 7n, symbol: "XTAR" }],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 7n,
            expirationLedger: 1_050_000,
          },
        ],
      },
    },
    registryEntries: [registryEntry({ address: SPENDER })],
    knownTokens: [TOKEN],
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]!.expirationLedger).toBe(1_050_000);
  expect(result.allowances[0]!.sources.sort()).toEqual(["events", "registry"]);
});

test("discoverAllowances › a candidate whose allowance() never answers is unreadable, excluded, and warned about - never silently dropped", async () => {
  // A normal budget, so the event scan (reserved 6s ahead of the read phase) actually runs and
  // finds the pair; the hang is caught by the per-read ALLOWANCE_TIMEOUT_MS, not the budget.
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 5n, hangs: true }],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 5n,
            expirationLedger: 1_100_000,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(0);
  expect(result.warnings.some((w) => w.code === "allowances_unreadable")).toBe(true);
}, 15_000);

test("discoverAllowances › a getEvents failure is reported in coverage but the registry-derived pairs still come back", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: OTHER_TOKEN, spender: OTHER_SPENDER, amount: 11n, symbol: "USDC" }],
      events: { "996001-1000000": { error: "getEvents unavailable" } },
    },
    registryEntries: [
      registryEntry({ address: OTHER_SPENDER, protocol: "soroswap", kind: "router" }),
    ],
    knownTokens: [OTHER_TOKEN],
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.coverage.find((c) => c.source === "events")).toMatchObject({ status: "failed" });
  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]!.spenderProtocol).toBe("soroswap");
});

test("discoverAllowances › registry guesses stop at the overall cap instead of overflowing it, so a real approval never triggers a capped warning", async () => {
  const manyRegistryEntries: ContractRegistryEntry[] = Array.from({ length: 10 }, (_, i) =>
    registryEntry({ address: contractAddress(i) })
  );
  const manyTokens = Array.from({ length: 10 }, (_, i) => contractAddress(100 + i));
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 1n, symbol: "XTAR" }],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 1n,
            expirationLedger: 1_100_000,
          },
        ],
      },
    },
    registryEntries: manyRegistryEntries,
    knownTokens: manyTokens,
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  // 10 registry entries x 10 tokens is 100 possible guesses, far more than the cap. The source
  // now stops once the list is full rather than filling its own quota and pushing the total
  // past the cut - which used to discard exactly as many guesses as the account had real
  // approvals, and warn about it as if those approvals might have been missed.
  expect(result.warnings.some((w) => w.code === "allowances_capped")).toBe(false);
  // The one real, event-discovered allowance always survives regardless of how many registry
  // guesses compete for the remaining slots.
  expect(result.allowances.some((a) => a.token === TOKEN && a.spender === SPENDER)).toBe(true);
});

test("discoverAllowances › an event scan that stops at its candidate cap says so, since the pairs it drops are the newest ones", async () => {
  const pairs = Array.from({ length: 60 }, (_, i) => ({
    token: TOKEN,
    spender: contractAddress(i),
    ledger: 999_000 + i,
    amount: 1n,
    expirationLedger: 1_100_000,
  }));
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: contractAddress(0), amount: 1n, symbol: "XTAR" }],
      events: { "996001-1000000": pairs },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  const warning = result.warnings.find((w) => w.code === "allowances_scan_incomplete");
  expect(warning).toBeDefined();
  expect(warning!.message).toContain("50 candidate pairs");
  expect(result.coverage.find((c) => c.source === "events")).toMatchObject({ status: "ok" });
});

test("discoverAllowances › a failed source is stated as a warning, not only in coverage", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [],
      events: { "996001-1000000": { error: "getEvents unavailable" } },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  // Coverage is a machine-readable footnote; a caller rendering only `warnings` would otherwise
  // show an empty list as an affirmative "this account has approved nobody".
  expect(result.warnings.some((w) => w.code === "allowances_source_failed")).toBe(true);
});

test("discoverAllowances › no candidates at all (empty registry, no events) returns cleanly with nothing to report", async () => {
  const deps = fakeAllowancesDeps({ world: { allowances: [] } });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toEqual([]);
  expect(result.coverage.find((c) => c.source === "registry")).toMatchObject({ status: "skipped" });
});

test("discoverAllowances › two approve events landing in the same ledger break the tie by transaction/operation order, not array order", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: SPENDER, amount: 3n, symbol: "XTAR" }],
      events: {
        "996001-1000000": [
          // Listed first in the array (and with the lower transactionIndex), but the SECOND one
          // below has the higher transactionIndex within the same ledger and must win.
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 3n,
            expirationLedger: 1_300_000,
            transactionIndex: 5,
          },
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 3n,
            expirationLedger: 900_000,
            transactionIndex: 2,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]!.expirationLedger).toBe(1_300_000);
});

test("discoverAllowances › a plain account approved as a spender (SEP-41 allows it) is still discovered via an approve event", async () => {
  const accountSpender = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [{ token: TOKEN, spender: accountSpender, amount: 9n, symbol: "XTAR" }],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: accountSpender,
            ledger: 999_000,
            amount: 9n,
            expirationLedger: 1_100_000,
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]!.spender).toBe(accountSpender);
  expect(result.allowances[0]!.spenderProtocol).toBeNull();
});

test("discoverAllowances › an approve event in a Stellar Asset Contract's own shape (a fourth topic naming the asset) is still discovered", async () => {
  const deps = fakeAllowancesDeps({
    world: {
      allowances: [
        { token: TOKEN, spender: SPENDER, amount: 8_046_156n, symbol: "BLND", decimals: 7 },
      ],
      events: {
        "996001-1000000": [
          {
            token: TOKEN,
            spender: SPENDER,
            ledger: 999_000,
            amount: 41_035_400n,
            expirationLedger: 1_100_000,
            sacAsset: "BLND:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
          },
        ],
      },
    },
  });

  const result = await discoverAllowances(OWNER, "testnet", deps);

  expect(result.allowances).toHaveLength(1);
  expect(result.allowances[0]).toMatchObject({
    token: TOKEN,
    spender: SPENDER,
    // The live read, not the event's own amount: a pool that approves a slippage-padded maximum
    // and then spends less leaves exactly this remainder standing.
    amount: "8046156",
    expirationLedger: 1_100_000,
    sources: ["events"],
  });
});

test("discoverAllowances › the event scan asks for both approve topic shapes, since the RPC matches topics by exact segment count", async () => {
  const deps = fakeAllowancesDeps({
    world: { allowances: [], events: {} },
  });

  await discoverAllowances(OWNER, "testnet", deps);

  const topics = deps.rpc.eventRequests[0]?.topics;
  expect(topics).toBeDefined();
  // A SEP-41 token emits [approve, from, spender]; a SAC appends the asset as a fourth topic.
  // Asking only for the three-segment shape misses every approval on a classic asset's SAC.
  expect(topics!.map((pattern) => pattern.length).sort((a, b) => a - b)).toEqual([3, 4]);
  const approve = xdr.ScVal.scvSymbol("approve").toXDR("base64");
  const owner = new Address(OWNER).toScVal().toXDR("base64");
  for (const pattern of topics!) {
    // Pinning the first two segments is what keeps the scan to THIS account's approvals: a
    // pattern that wildcarded either one would still have the right lengths while matching
    // other events, or other people's.
    expect(pattern[0]).toBe(approve);
    expect(pattern[1]).toBe(owner);
    expect(pattern.slice(2).every((segment) => segment === "*")).toBe(true);
  }
});
