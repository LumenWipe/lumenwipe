/**
 * A stand-in for what Soroban token discovery talks to: an RPC that serves contract instances,
 * answers `getEvents` per requested window, and simulates a token's `balance` / `symbol` /
 * `decimals`. Real XDR throughout, so the decode path is the one under test; the shapes mirror
 * live responses captured from the public RPC.
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
import { contractSimulation } from "./fake-exit-adapter";
import { archivedAnswer, type EntryArchival } from "./entry-archival";
import { eventsPage, healthAnswer, latestLedger } from "../../support/rpc-fixtures";

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
  /** Contracts that emitted a credit to the account inside this ledger window, one event each. */
  contracts: string[];
  /** Contracts whose events sit just past the window's end ledger: what a cursor page, which
   *  carries no end ledger, runs into on the real RPC. */
  spill?: string[];
}

export interface FakeSorobanWorld {
  tokens: FakeToken[];
  /** How the ledger serves the token entries it holds; archived ones simulate with an automatic
   *  restore, as the RPC does since Protocol 23. */
  archival?: EntryArchival;
  latestLedger?: number;
  /** Per requested window `${startLedger}-${endLedger}`; a window listed with `error` rejects. */
  events?: Record<string, FakeEventWindow | { error: string }>;
  /** What the indexer answers, one entry per page in order; no entry means the source is off. */
  indexer?: Array<{ status: number; body: unknown } | { throws: string }>;
}

export const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";

function instanceEntry(contract: string, isStellarAsset: boolean): rpc.Api.LedgerEntryResult {
  const key = new Contract(contract).getFootprint();
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: isStellarAsset
            ? xdr.ContractExecutable.contractExecutableStellarAsset()
            : xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32).fill(7)),
          storage: null,
        })
      ),
    })
  );
  return { key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 };
}

/** The contract and function a simulated single-invocation transaction calls. */
function calledFunction(tx: Transaction): { contract: string; fn: string } | null {
  const envelope = tx.toEnvelope();
  const op = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations[0] : undefined;
  if (!op || op.body.type !== "invokeHostFunction") return null;
  const host = op.body.invokeHostFunctionOp.hostFunction;
  if (host.type !== "hostFunctionTypeInvokeContract") return null;
  const call = host.invokeContract;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
  };
}

function simulationWith(
  retval: xdr.ScVal,
  archival: EntryArchival = "live"
): rpc.Api.SimulateTransactionResponse {
  return contractSimulation(archival === "live" ? "ok" : "autoRestore", [], "1000", retval);
}

export interface FakeEventRequest {
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  topics?: string[][];
}

export function fakeSorobanRpc(world: FakeSorobanWorld): SorobanTokenRpc & {
  eventRequests: FakeEventRequest[];
} {
  const tokens = new Map(world.tokens.map((t) => [t.contract, t]));
  const eventRequests: FakeEventRequest[] = [];
  const never = new Promise<never>(() => {});
  return {
    eventRequests,
    async getHealth() {
      return healthAnswer(world.latestLedger ?? 1_000_000);
    },
    async getLatestLedger() {
      return latestLedger(world.latestLedger ?? 1_000_000);
    },
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const entries: rpc.Api.LedgerEntryResult[] = [];
      for (const key of keys) {
        if (key.type !== "contractData") throw new Error("not stubbed");
        const contract = Address.fromScAddress(key.contractData.contract).toString();
        const token = tokens.get(contract);
        if (!token || token.exists === false) continue;
        entries.push(instanceEntry(contract, token.isStellarAsset ?? false));
      }
      return archivedAnswer({ latestLedger: 1, entries }, world.archival ?? "live");
    },
    // Pages like the real RPC: `limit` events per page, a cursor that is never empty, and a
    // cursor request that knows no end ledger - so a window's `spill` shows up on the page after
    // its own events, exactly where a scan that forgot the chunk edge would pick it up.
    async getEvents(request) {
      const r = request as {
        startLedger?: number;
        endLedger?: number;
        cursor?: string;
        limit?: number;
        filters?: rpc.Api.EventFilter[];
      };
      eventRequests.push({
        startLedger: r.startLedger,
        endLedger: r.endLedger,
        cursor: r.cursor,
        topics: r.filters?.[0]?.topics,
      });
      let start = r.startLedger ?? 0;
      let end = r.endLedger ?? 0;
      let offset = 0;
      if (r.cursor !== undefined) {
        const [s, e, o] = r.cursor.split("/").map(Number);
        start = s ?? 0;
        end = e ?? 0;
        offset = o ?? 0;
      }
      const window = world.events?.[`${start}-${end}`];
      if (window && "error" in window) throw new Error(window.error);
      const inWindow = (window?.contracts ?? []).map((contract) => ({ contract, ledger: end }));
      const spilled = (window?.spill ?? []).map((contract) => ({ contract, ledger: end + 1 }));
      const all = [...inWindow, ...spilled];
      const limit = r.limit ?? 1_000;
      const page = all.slice(offset, offset + limit);
      const events = page.map(({ contract, ledger }, i): rpc.Api.EventResponse => ({
        type: "contract",
        ledger,
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        contractId: new Contract(contract),
        id: `${start}-${offset + i}`,
        inSuccessfulContractCall: true,
        txHash: "00".repeat(32),
        topic: [],
        value: xdr.ScVal.scvVoid(),
        operationIndex: 0,
        transactionIndex: 0,
      }));
      return eventsPage(
        events,
        `${start}/${end}/${offset + page.length}`,
        world.latestLedger ?? 1_000_000
      );
    },
    async simulateTransaction(tx) {
      const call = calledFunction(tx as Transaction);
      if (!call) return contractSimulation("error", [], "0");
      const token = tokens.get(call.contract);
      if (!token) return contractSimulation("error", [], "0");
      if (call.fn === "balance") {
        if (token.hangs) return never as never;
        if (token.balance === null) return contractSimulation("error", [], "0");
        return simulationWith(nativeToScVal(token.balance, { type: "i128" }), world.archival);
      }
      if (call.fn === "symbol") {
        if (token.symbol === null) return contractSimulation("error", [], "0");
        return simulationWith(
          nativeToScVal(token.symbol ?? "TKN", { type: "string" }),
          world.archival
        );
      }
      if (call.fn === "decimals") {
        if (token.decimals === null) return contractSimulation("error", [], "0");
        return simulationWith(nativeToScVal(token.decimals ?? 7, { type: "u32" }), world.archival);
      }
      return contractSimulation("error", [], "0");
    },
  };
}

export interface IndexerCall {
  url: string;
  authorization: string | null;
}

export function fakeIndexerFetch(
  pages: NonNullable<FakeSorobanWorld["indexer"]>,
  calls: IndexerCall[] = []
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const answer = pages[calls.length - 1] ?? { status: 500, body: {} };
    if ("throws" in answer) throw new Error(answer.throws);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** One page of the indexer's `/accounts/{G}/movements`, received rows only, as it answers. */
export function indexerMovementsBody(assets: string[], nextCursor: string | null): unknown {
  return {
    data: {
      account: ACCOUNT,
      movements: assets.map((asset, i) => ({
        ledger: 65_000_000 - i,
        movement_kind: "transfer",
        direction: "received",
        asset,
        amount: "1",
        provenance: "cap67_event",
      })),
      next_cursor: nextCursor,
      coverage_note: "all assets through ledger 65000000",
    },
    as_of: "2026-11-17T00:00:00Z",
  };
}

export interface FakeDepsOptions {
  world: FakeSorobanWorld;
  listCandidates?: string[];
  manualCandidates?: string[];
  positions?: DefiPosition[];
  budgetMs?: number;
  /** A controllable clock, in ms; advanced by the tests that exercise the budget. */
  clock?: { now: number };
  indexerApiKey?: string | null;
}

export function fakeSorobanDeps(options: FakeDepsOptions): SorobanTokensDeps & {
  rpc: ReturnType<typeof fakeSorobanRpc>;
  indexerCalls: IndexerCall[];
} {
  const rpcStub = fakeSorobanRpc(options.world);
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  const indexerCalls: IndexerCall[] = [];
  return {
    rpc: rpcStub,
    indexerCalls,
    indexer: options.world.indexer
      ? {
          baseUrl: "https://indexer.test/v1",
          apiKey: options.indexerApiKey === undefined ? "sip_test" : options.indexerApiKey,
          fetch: fakeIndexerFetch(options.world.indexer, indexerCalls),
        }
      : null,
    listCandidates: options.listCandidates ?? [],
    manualCandidates: options.manualCandidates ?? [],
    positions: options.positions ?? [],
    now: () => clock.now,
    budgetMs: options.budgetMs ?? 20_000,
  };
}

/** No network at all: the account-state tests are about the Horizon read, not token discovery. */
export const OFFLINE_SOROBAN_TOKENS: AccountReadOptions = {
  ledgerCloseTime: () => Promise.resolve(null),
  sorobanTokensDeps: () => fakeSorobanDeps({ world: { tokens: [] }, listCandidates: [] }),
};

export { scValToNative };
