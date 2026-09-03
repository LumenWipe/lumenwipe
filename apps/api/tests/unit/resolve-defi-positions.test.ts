import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { resolveDefiPositions, DEGRADED_SOURCE } from "@/lib/defi-positions/resolve-defi-positions";
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
const AQUARIUS_POOL = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const AQUARIUS_WASM_HASH = "3".repeat(64);

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
  });

  expect(result.network).toBe("mainnet");
  expect(result.source).toBe("empty");
  expect(result.timestamp).toBe("2026-01-01T00:00:00.000Z");
  expect(result.positions).toEqual([]);
});

// ─── mainnet: degraded mode ──────────────────────────────────────────────────

test("mainnet degrades to a direct read when OctoPos is unconfigured", async () => {
  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: "" },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.network).toBe("mainnet");
  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
  expect(result.positions).toEqual([]);
});

test("mainnet degrades to a direct read when OctoPos is unavailable", async () => {
  const octoposFetch = fakeFetch(() => new Response("", { status: 503 }));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
});

test("mainnet degrades when OctoPos returns a payload the adapter cannot recognize", async () => {
  const octoposFetch = fakeFetch(() => jsonResponse({ nope: "not a portfolio" }));

  const result = await resolveDefiPositions(ADDRESS, "mainnet", {
    octopos: { baseUrl: OCTOPOS_BASE, fetch: octoposFetch },
    directRead: { rpc: mockRpc([]), registryEntries: [] },
  });

  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.timestamp).toBeNull();
});

test("a degraded mainnet fallback still surfaces positions the direct read actually finds", async () => {
  const entry: ContractRegistryEntry = {
    network: "mainnet",
    protocol: "phoenix",
    kind: "pool",
    address: AQUARIUS_POOL,
    wasmHash: AQUARIUS_WASM_HASH,
    version: "v1",
    label: "test fixture",
    verifiedLive: true,
  };
  const balanceKey = variantVal("Balance", addressVal(ADDRESS));
  const rpc = mockRpc([
    contractInstanceEntry(AQUARIUS_POOL, AQUARIUS_WASM_HASH),
    contractDataEntry(AQUARIUS_POOL, balanceKey, i128Val(42_0000000n)),
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
      contractAddress: AQUARIUS_POOL,
      wasmHash: AQUARIUS_WASM_HASH,
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
    address: AQUARIUS_POOL,
    wasmHash: AQUARIUS_WASM_HASH,
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
