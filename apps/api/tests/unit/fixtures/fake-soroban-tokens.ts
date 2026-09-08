/**
 * Stand-ins for what Soroban token discovery talks to: the explorer's per-account listing, and an
 * RPC that serves contract instances, answers `getEvents` per requested window, and simulates a
 * token's `balance` / `symbol` / `decimals`. Real XDR throughout, so the decode path is the one
 * under test; the shapes mirror live responses captured from stellar.expert and the public RPC.
 */
import {
  Address,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { DefiPosition } from "@lumenwipe/types";
import type { AccountReadOptions } from "@/lib/stellar/account-state";
import type { SorobanTokenRpc, SorobanTokensDeps } from "@/lib/stellar/soroban-tokens";
import { rawSimulation } from "./fake-exit-adapter";

export interface FakeToken {
  contract: string;
  /** Absent: the contract does not exist on the ledger. */
  exists?: boolean;
  isStellarAsset?: boolean;
  /** null: `balance()` fails (a hostile or broken token). */
  balance: bigint | null;
  symbol?: string | null;
  decimals?: number | null;
  /** The balance call never answers within the probe's timeout. */
  hangs?: boolean;
}

export interface FakeEventWindow {
  /** Contracts that emitted a credit to the account inside this ledger window. */
  contracts: string[];
}

export interface FakeSorobanWorld {
  tokens: FakeToken[];
  latestLedger?: number;
  /** Per requested window `${startLedger}-${endLedger}`; a window listed with `error` rejects. */
  events?: Record<string, FakeEventWindow | { error: string }>;
  /** What the explorer answers: a status and body, or a thrown network error. */
  explorer?: { status: number; body: unknown } | { throws: string };
}

export const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";

function instanceEntry(contract: string, isStellarAsset: boolean): rpc.Api.LedgerEntryResult {
  const key = new Contract(contract).getFootprint();
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: isStellarAsset
            ? xdr.ContractExecutable.contractExecutableStellarAsset()
            : xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 7)),
          storage: null,
        })
      ),
    })
  );
  return { key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 };
}

/** The contract and function a simulated single-invocation transaction calls. */
function calledFunction(tx: Transaction): { contract: string; fn: string } | null {
  const op = tx.toEnvelope().v1().tx().operations()[0];
  if (!op || op.body().switch() !== xdr.OperationType.invokeHostFunction()) return null;
  const host = op.body().invokeHostFunctionOp().hostFunction();
  if (host.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  const call = host.invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
  };
}

function simulationWith(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  const base = rawSimulation("ok", [], "1000") as unknown as Record<string, unknown>;
  return {
    ...base,
    results: [{ auth: [], xdr: retval.toXDR("base64") }],
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

export function fakeSorobanRpc(world: FakeSorobanWorld): SorobanTokenRpc & {
  eventRequests: Array<{ startLedger?: number; endLedger?: number; topics?: string[][] }>;
} {
  const tokens = new Map(world.tokens.map((t) => [t.contract, t]));
  const eventRequests: Array<{ startLedger?: number; endLedger?: number; topics?: string[][] }> =
    [];
  const never = new Promise<never>(() => {});
  return {
    eventRequests,
    async getLatestLedger() {
      return {
        id: "x",
        sequence: world.latestLedger ?? 1_000_000,
        protocolVersion: 25,
      } as unknown as rpc.Api.GetLatestLedgerResponse;
    },
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const entries: rpc.Api.LedgerEntryResult[] = [];
      for (const key of keys) {
        const contract = Address.fromScAddress(key.contractData().contract()).toString();
        const token = tokens.get(contract);
        if (!token || token.exists === false) continue;
        entries.push(instanceEntry(contract, token.isStellarAsset ?? false));
      }
      return { latestLedger: 1, entries };
    },
    async getEvents(request) {
      const r = request as {
        startLedger?: number;
        endLedger?: number;
        filters?: rpc.Api.EventFilter[];
      };
      eventRequests.push({
        startLedger: r.startLedger,
        endLedger: r.endLedger,
        topics: r.filters?.[0]?.topics,
      });
      const window = world.events?.[`${r.startLedger}-${r.endLedger}`];
      if (window && "error" in window) throw new Error(window.error);
      const events = (window?.contracts ?? []).map((contract, i) => ({
        type: "contract",
        ledger: r.endLedger ?? 0,
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        contractId: new Contract(contract),
        id: `${r.startLedger}-${i}`,
        pagingToken: `${r.startLedger}-${i}`,
        inSuccessfulContractCall: true,
        txHash: "00".repeat(32),
        topic: [],
        value: xdr.ScVal.scvVoid(),
        operationIndex: 0,
        transactionIndex: 0,
      }));
      return {
        latestLedger: world.latestLedger ?? 1_000_000,
        events,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse;
    },
    async simulateTransaction(tx) {
      const call = calledFunction(tx as Transaction);
      if (!call) return rawSimulation("error", [], "0");
      const token = tokens.get(call.contract);
      if (!token) return rawSimulation("error", [], "0");
      if (call.fn === "balance") {
        if (token.hangs) return never as never;
        if (token.balance === null) return rawSimulation("error", [], "0");
        return simulationWith(nativeToScVal(token.balance, { type: "i128" }));
      }
      if (call.fn === "symbol") {
        if (token.symbol === null) return rawSimulation("error", [], "0");
        return simulationWith(nativeToScVal(token.symbol ?? "TKN", { type: "string" }));
      }
      if (call.fn === "decimals") {
        if (token.decimals === null) return rawSimulation("error", [], "0");
        return simulationWith(nativeToScVal(token.decimals ?? 7, { type: "u32" }));
      }
      return rawSimulation("error", [], "0");
    },
  };
}

export function fakeExplorerFetch(world: FakeSorobanWorld, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const answer = world.explorer ?? { status: 404, body: { error: "not found" } };
    if ("throws" in answer) throw new Error(answer.throws);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** The explorer's `/account/{G}/value` body, as captured live: classic and contract balances mixed. */
export function explorerValueBody(
  contracts: Array<{ contract: string; balance: string }>
): unknown {
  return {
    address: ACCOUNT,
    balances: [
      { asset: "XLM", balance: "32829200", flags: 1, updated: 1782250501, value: 0.62 },
      ...contracts.map((c) => ({ asset: c.contract, balance: c.balance, flags: 1, updated: 1 })),
      {
        asset: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN-1",
        balance: "0",
        flags: 1,
        updated: 1,
      },
    ],
    total: 0.62,
    currency: "USD",
  };
}

export interface FakeDepsOptions {
  world: FakeSorobanWorld;
  listCandidates?: string[];
  manualCandidates?: string[];
  positions?: DefiPosition[];
  explorerBaseUrl?: string;
  budgetMs?: number;
  /** A controllable clock, in ms; advanced by the tests that exercise the budget. */
  clock?: { now: number };
}

export function fakeSorobanDeps(options: FakeDepsOptions): SorobanTokensDeps & {
  rpc: ReturnType<typeof fakeSorobanRpc>;
  explorerCalls: string[];
} {
  const explorerCalls: string[] = [];
  const rpcStub = fakeSorobanRpc(options.world);
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  return {
    rpc: rpcStub,
    explorerCalls,
    fetch: fakeExplorerFetch(options.world, explorerCalls),
    explorerBaseUrl: options.explorerBaseUrl ?? "https://explorer.test",
    listCandidates: options.listCandidates ?? [],
    manualCandidates: options.manualCandidates ?? [],
    positions: options.positions ?? [],
    now: () => clock.now,
    budgetMs: options.budgetMs ?? 20_000,
  };
}

/** No network at all: the account-state tests are about the Horizon read, not token discovery. */
export const OFFLINE_SOROBAN_TOKENS: AccountReadOptions = {
  sorobanTokensDeps: () =>
    fakeSorobanDeps({ world: { tokens: [] }, explorerBaseUrl: "", listCandidates: [] }),
};

export { scValToNative };
