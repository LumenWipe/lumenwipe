import { afterEach, test, expect, mock, spyOn } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  resolveDefiPositions,
  DEGRADED_SOURCE,
  DEGRADED_SOURCE_CONFIRMED_EMPTY,
  degradedFallbackCount,
  resetDegradedFallbackCount,
} from "@/lib/defi-positions/resolve-defi-positions";
import * as contractRegistry from "@/lib/contract-registry";
import {
  addressVal,
  detectDefiPositionsViaDirectRead,
  variantVal,
} from "@/lib/defi-positions/testnet-direct-read";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import type { getRpcServer } from "@/lib/stellar/rpc";
import {
  contractDataEntry,
  contractInstanceEntry,
  i128Val,
  mockRpc,
} from "./fixtures/testnet-direct-read-helpers";

type RpcServer = ReturnType<typeof getRpcServer>;

const ADDRESS = Keypair.random().publicKey();
const OCTOPOS_BASE = "https://octopos.example";
const PHOENIX_POOL = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const PHOENIX_WASM_HASH = "3".repeat(64);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function fakeFetch(handler: () => Response | Promise<Response>): typeof globalThis.fetch {
  return (async () => handler()) as unknown as typeof globalThis.fetch;
}

// ─── testnet: designed primary path, never touches OctoPos ─────────────────

test("testnet always uses the direct-read path and never calls OctoPos", async () => {
  let octoposCalled = false;
  const octoposFetch = fakeFetch(() => {
    octoposCalled = true;
    throw new Error("OctoPos should never be called for testnet");
  });

  const result = await resolveDefiPositions(ADDRESS, "testnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(octoposCalled).toBe(false);
  expect(result.network).toBe("testnet");
  expect(result.source).toBe("testnet-direct-read");
  expect(result.timestamp).not.toBeNull();
});

// ─── mainnet: OctoPos succeeds ───────────────────────────────────────────────

test("mainnet returns the normalized OctoPos result untouched on success", async () => {
  const raw = {
    positions: [],
    source: "empty",
    timestamp: "2026-01-01T00:00:00.000Z",
    queryKeys: {},
  };
  const octoposFetch = fakeFetch(() => jsonResponse(raw));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    complete: { rpc: mockRpc([]), resolveWasmHash: () => ({ status: "unknown", wasmHash: "" }) },
  });

  expect(result.network).toBe("mainnet");
  expect(result.source).toBe("empty");
  expect(result.timestamp).toBe("2026-01-01T00:00:00.000Z");
  expect(result.positions).toEqual([]);
});

test("mainnet completes an indexer's LP position from the pool's instance when the registry knows its code", async () => {
  const POOL = "CCSY43EHJAHT3NQDYKAMJXRFBEEH7OXDL3J3VNGO33UUSEXWNN27GBIZ";
  const SHARE = "CC4BPROIXISEFC7UKTB2HYBLNSNP27WNCR7YNZOHXLTPTGDKFMKYQ2YN";
  const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const AQUA = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";
  const HASH = "ae0da5a84b15805c5c7931ac567a8d1b34be3f26b483993d9ff80cb2c3de9852";
  const raw = {
    positions: [
      {
        protocol: "aquarius",
        type: "LP",
        poolAddress: POOL,
        shareAmount: "1000000",
        usdValue: null,
      },
    ],
    source: "snapshot",
    timestamp: "2026-01-01T00:00:00.000Z",
    queryKeys: {},
  };
  const octoposFetch = fakeFetch(() => jsonResponse(raw));
  const vec = (s: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    complete: {
      rpc: mockRpc([
        contractInstanceEntry(POOL, HASH, [
          [vec("TokenA"), addressVal(XLM)],
          [vec("TokenB"), addressVal(AQUA)],
          [vec("TokenShare"), addressVal(SHARE)],
        ]),
      ]),
      resolveWasmHash: (_network, hash) =>
        hash === HASH
          ? {
              status: "known",
              protocol: "aquarius",
              kind: "pool",
              version: "constant_product",
              wasmHash: hash,
            }
          : { status: "unknown", wasmHash: hash },
    },
  });
  expect(result.source).toBe("snapshot");
  expect(result.positions[0]).toMatchObject({
    protocol: "aquarius",
    contractAddress: POOL,
    tokens: [XLM, AQUA],
    shareToken: SHARE,
    poolType: "constant_product",
  });
});

// ─── mainnet: degraded mode ──────────────────────────────────────────────────

test("mainnet degrades to a direct read when OctoPos is unconfigured", async () => {
  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: "" },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.network).toBe("mainnet");
  // The direct read ran and found nothing - a stronger signal than "we don't know," and
  // distinct from the direct read itself also failing (DEGRADED_SOURCE, still unconfirmed).
  expect(result.source).toBe(DEGRADED_SOURCE_CONFIRMED_EMPTY);
  expect(result.timestamp).toBeNull();
  expect(result.positions).toEqual([]);
});

test("mainnet degrades to a direct read when OctoPos is unavailable", async () => {
  const octoposFetch = fakeFetch(() => new Response("", { status: 503 }));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE_CONFIRMED_EMPTY);
  expect(result.timestamp).toBeNull();
});

test("mainnet degrades when OctoPos returns a payload the adapter cannot recognize", async () => {
  const octoposFetch = fakeFetch(() => jsonResponse({ nope: "not a portfolio" }));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE_CONFIRMED_EMPTY);
  expect(result.timestamp).toBeNull();
});

// OctoPos's genuine "not-tracked" response (a real 200, not a failure) carries exactly the
// same "no confirmed snapshot" status as an outage - positions-gate.ts already treats both
// identically - so it deserves the same chance at a direct-read confirmation rather than
// going straight to the hard blocker with no on-chain check at all.
test("a genuine not-tracked OctoPos response also attempts a direct-read confirmation", async () => {
  const raw = { positions: [], source: "not-tracked", timestamp: null, queryKeys: {} };
  const octoposFetch = fakeFetch(() => jsonResponse(raw));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE_CONFIRMED_EMPTY);
  expect(result.timestamp).toBeNull();
});

// A malicious or misbehaving OctoPos controls `raw.source` verbatim (normalizeOctoPosPortfolio
// passes it through untouched) - if it could forge our own internal "the direct read already
// confirmed this is empty" sentinel, it could hide a real position behind a claim that was
// never actually verified on-chain. That sentinel must only ever come from this module's own
// fallback logic actually running the direct read, never from a vendor-supplied string.
test("a forged 'source' claiming the internal degraded-confirmed-empty marker is not trusted - the direct read still runs for real", async () => {
  const entry: ContractRegistryEntry = {
    network: "mainnet",
    protocol: "phoenix",
    kind: "pool",
    address: PHOENIX_POOL,
    wasmHash: PHOENIX_WASM_HASH,
    version: "v1",
    label: "test fixture",
    verifiedLive: true,
  };
  const balanceKey = variantVal("Balance", addressVal(ADDRESS));
  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    contractDataEntry(PHOENIX_POOL, balanceKey, i128Val(42_0000000n)),
  ]);
  const raw = {
    positions: [],
    unrecognizedPositions: [],
    source: DEGRADED_SOURCE_CONFIRMED_EMPTY,
    timestamp: null,
    queryKeys: {},
  };
  const octoposFetch = fakeFetch(() => jsonResponse(raw));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc, registryEntries: [entry] },
  });

  expect(result.positions).toEqual([
    {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      wasmHash: PHOENIX_WASM_HASH,
      shareAmount: "420000000",
      usdValue: null,
    },
  ]);
});

// The direct-read fallback's registry has a `validUntil` and a documented fail-closed rule for
// *conversions* (soroswapConversionContracts) - but detectDefiPositionsViaDirectRead reads
// entriesForNetwork() directly, with no freshness check at all. A stale registry (rotated
// contract addresses, a protocol never added) sweeping "nothing" is not the same confidence as
// a fresh one doing the same - it must not be trusted as a genuine confirmation either.
test("a stale contract registry is never trusted as a genuine confirmed-empty result", async () => {
  spyOn(contractRegistry, "isRegistryFresh").mockReturnValue(false);

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: "" },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
});

afterEach(() => {
  mock.restore();
});

// The whole point of tightening OctoPos's patience (octopos-http.ts) is that degraded mode
// should be rare - but "rare" is unverifiable without a count. rateLimitHits() in
// horizon-http.ts is the established pattern for exactly this: a process-lifetime counter
// surfaced at /health, so a rising value is an early operational signal, not a discovery made
// from user complaints.
test("degradedFallbackCount counts every fallback into degraded mode, not just some reasons", async () => {
  resetDegradedFallbackCount();
  expect(degradedFallbackCount()).toBe(0);

  await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: "" }, // unconfigured
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });
  expect(degradedFallbackCount()).toBe(1);

  const octoposFetch = fakeFetch(() => new Response("", { status: 503 }));
  await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });
  expect(degradedFallbackCount()).toBe(2);
});

test("degradedFallbackCount does not increment on a normal OctoPos success", async () => {
  resetDegradedFallbackCount();
  const raw = {
    positions: [],
    source: "empty",
    timestamp: new Date().toISOString(),
    queryKeys: {},
  };
  const octoposFetch = fakeFetch(() => jsonResponse(raw));

  await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    complete: { rpc: mockRpc([]), resolveWasmHash: () => ({ status: "unknown", wasmHash: "" }) },
  });

  expect(degradedFallbackCount()).toBe(0);
});

test("a degraded mainnet fallback still surfaces positions the direct read actually finds", async () => {
  const entry: ContractRegistryEntry = {
    network: "mainnet",
    protocol: "phoenix",
    kind: "pool",
    address: PHOENIX_POOL,
    wasmHash: PHOENIX_WASM_HASH,
    version: "v1",
    label: "test fixture",
    verifiedLive: true,
  };
  const balanceKey = variantVal("Balance", addressVal(ADDRESS));
  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    contractDataEntry(PHOENIX_POOL, balanceKey, i128Val(42_0000000n)),
  ]);

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: "" },
    directRead: { rpc, registryEntries: [entry] },
  });

  // Proves this reuses the same decode path detectDefiPositionsViaDirectRead exercises on every
  // testnet CI run, rather than a separate stub that only ever returns an empty placeholder.
  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
  expect(result.positions).toEqual([
    {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      wasmHash: PHOENIX_WASM_HASH,
      shareAmount: "420000000",
      usdValue: null,
    },
  ]);

  const direct = await detectDefiPositionsViaDirectRead(ADDRESS, "mainnet", {
    rpc,
    registryEntries: [entry],
  });
  expect(direct.positions).toEqual(result.positions);
});

test("never throws even when both OctoPos and the direct-read RPC dependency fail", async () => {
  const octoposFetch = fakeFetch(() => new Response("", { status: 500 }));
  const failingRpc = {
    getLedgerEntries: async () => {
      throw new Error("ECONNRESET");
    },
  } as unknown as RpcServer;

  const entry: ContractRegistryEntry = {
    network: "mainnet",
    protocol: "phoenix",
    kind: "pool",
    address: PHOENIX_POOL,
    wasmHash: PHOENIX_WASM_HASH,
    version: "v1",
    label: "test fixture",
    verifiedLive: true,
  };

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: failingRpc, registryEntries: [entry] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
  expect(result.positions).toEqual([]);
});
