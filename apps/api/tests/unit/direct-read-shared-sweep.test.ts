import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import * as contractRegistry from "@/lib/contract-registry";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import {
  addressVal,
  detectDefiPositionsViaDirectRead,
  symbolVal,
  variantVal,
} from "@/lib/defi-positions/testnet-direct-read";
import { DEGRADED_SOURCE, resolveDefiPositions } from "@/lib/defi-positions/resolve-defi-positions";
import {
  assessDefiPositionsGate,
  DEFI_POSITIONS_UNAVAILABLE_CODE,
} from "@/lib/defi-positions/positions-gate";
import {
  addressListVal,
  contractDataEntry,
  contractInstanceEntry,
  mockRpc,
  structVal,
  u32MapVal,
} from "./fixtures/testnet-direct-read-helpers";
import { fakeRpcServer } from "../support/rpc-server";
import { fakeFetch } from "../support/fetch";

const HOLDER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const ASSET = Keypair.random().publicKey();
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const POOL_HASH = "a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e";

const REGISTRY: ContractRegistryEntry[] = [
  {
    network: "testnet",
    protocol: "blend",
    kind: "pool",
    address: POOL,
    wasmHash: POOL_HASH,
    version: "v2",
    label: "test fixture",
    verifiedLive: true,
  },
];

const supplied = (account: string, amount: bigint) =>
  contractDataEntry(
    POOL,
    variantVal("Positions", addressVal(account)),
    structVal({
      supply: u32MapVal([[0, amount]]),
      collateral: u32MapVal([]),
      liabilities: u32MapVal([]),
    })
  );

const ledger = (amount: bigint) =>
  mockRpc([
    contractInstanceEntry(POOL, POOL_HASH),
    contractDataEntry(POOL, symbolVal("ResList"), addressListVal([ASSET])),
    supplied(HOLDER, amount),
  ]);

/** Counts calls and holds each open a moment, so two sweeps started together overlap. */
function countingRpc(inner: ReturnType<typeof mockRpc>) {
  let calls = 0;
  const rpc = fakeRpcServer({
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inner.getLedgerEntries(...keys);
    },
  });
  return { rpc, calls: () => calls };
}

const ONE_SWEEP = 2;

const detect = (
  account: string,
  rpc: ReturnType<typeof fakeRpcServer>,
  network: "testnet" | "mainnet" = "testnet"
) => detectDefiPositionsViaDirectRead(account, network, { rpc, registryEntries: REGISTRY });

beforeEach(() => {
  spyOn(contractRegistry, "isRegistryFresh").mockReturnValue(true);
});

afterEach(() => {
  mock.restore();
});

test("two concurrent sweeps for one account make one sweep's calls, each caller its own copy", async () => {
  const { rpc, calls } = countingRpc(ledger(5n));
  const [a, b] = await Promise.all([detect(HOLDER, rpc), detect(HOLDER, rpc)]);
  expect(calls()).toBe(ONE_SWEEP);
  expect(a).toEqual(b);
  expect(a.positions).toHaveLength(1);
  expect(a).not.toBe(b);
  a.positions.pop();
  expect(b.positions).toHaveLength(1);
});

test("concurrent sweeps for different accounts never share a result", async () => {
  const { rpc, calls } = countingRpc(ledger(5n));
  const [held, other] = await Promise.all([detect(HOLDER, rpc), detect(OTHER, rpc)]);
  expect(calls()).toBe(2 * ONE_SWEEP);
  expect(held.address).toBe(HOLDER);
  expect(held.positions).toHaveLength(1);
  expect(other.address).toBe(OTHER);
  expect(other.positions).toEqual([]);
});

test("concurrent sweeps for one account on different networks never share a result", async () => {
  const { rpc, calls } = countingRpc(ledger(5n));
  const [testnet, mainnet] = await Promise.all([
    detect(HOLDER, rpc, "testnet"),
    detect(HOLDER, rpc, "mainnet"),
  ]);
  expect(calls()).toBe(2 * ONE_SWEEP);
  expect(testnet.network).toBe("testnet");
  expect(mainnet.network).toBe("mainnet");
});

test("a sweep started after another settled reads the ledger again", async () => {
  let inner = ledger(5n);
  const { rpc, calls } = countingRpc(
    fakeRpcServer({ getLedgerEntries: (...keys) => inner.getLedgerEntries(...keys) })
  );
  const first = await detect(HOLDER, rpc);
  inner = ledger(9n);
  const second = await detect(HOLDER, rpc);
  expect(calls()).toBe(2 * ONE_SWEEP);
  expect(first.positions[0]).toMatchObject({ bTokenAmount: "5" });
  expect(second.positions[0]).toMatchObject({ bTokenAmount: "9" });
});

test("a shared sweep cut off by the first caller's deadline degrades both, reporting nothing", async () => {
  const inner = ledger(5n);
  const deadline = new AbortController();
  let calls = 0;
  const rpc = fakeRpcServer({
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls += 1;
      if (calls === 1) return inner.getLedgerEntries(...keys);
      await new Promise((_, reject) => {
        deadline.signal.addEventListener("abort", () => reject(new Error("deadline")));
      });
      throw new Error("unreachable");
    },
  });
  const notTracked = { positions: [], source: "not-tracked", timestamp: null, queryKeys: {} };
  const resolve = () =>
    resolveDefiPositions(HOLDER, "mainnet", {
      octopos: {
        baseUrl: "https://octopos.example",
        fetch: fakeFetch(() => new Response(JSON.stringify(notTracked), { status: 200 })),
      },
      directRead: { rpc, registryEntries: REGISTRY },
    });
  const both = Promise.all([resolve(), resolve()]);
  while (calls < 2) await new Promise((r) => setTimeout(r, 1));
  deadline.abort();
  const results = await both;
  expect(calls).toBe(ONE_SWEEP);
  for (const result of results) {
    expect(result.source).toBe(DEGRADED_SOURCE);
    expect(result.positions).toEqual([]);
    expect(assessDefiPositionsGate(result, new Date(), 0).map((b) => b.code)).toContain(
      DEFI_POSITIONS_UNAVAILABLE_CODE
    );
  }
});
