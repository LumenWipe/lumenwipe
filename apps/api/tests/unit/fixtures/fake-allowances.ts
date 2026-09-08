/**
 * Stand-ins for what allowance discovery talks to: an RPC that answers `getEvents` for `approve`
 * events per requested window and simulates a token's `allowance` / `symbol`. Real XDR throughout,
 * so the decode path (topics, event data, simulation results) is the one under test.
 */
import { Address, Contract, nativeToScVal, rpc, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import type { AllowanceRpc, AllowancesDeps } from "@/lib/stellar/allowances";
import { rawSimulation } from "./fake-exit-adapter";

export const OWNER = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";

export interface FakeAllowance {
  token: string;
  spender: string;
  /** The live amount `allowance(owner, spender)` answers with; 0 means none outstanding. */
  amount: bigint;
  symbol?: string | null;
  /** `symbol()` never answers. */
  symbolHangs?: boolean;
  /** `allowance()` never answers. */
  hangs?: boolean;
}

export interface FakeApproveEvent {
  token: string;
  spender: string;
  ledger: number;
  amount: bigint;
  expirationLedger: number;
}

export interface FakeAllowancesWorld {
  allowances: FakeAllowance[];
  latestLedger?: number;
  /** Per requested window `${startLedger}-${endLedger}`; a window listed with `error` rejects. */
  events?: Record<string, FakeApproveEvent[] | { error: string }>;
}

function calledInvocation(
  tx: Transaction
): { contract: string; fn: string; args: xdr.ScVal[] } | null {
  const op = tx.toEnvelope().v1().tx().operations()[0];
  if (!op || op.body().switch() !== xdr.OperationType.invokeHostFunction()) return null;
  const host = op.body().invokeHostFunctionOp().hostFunction();
  if (host.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  const call = host.invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
    args: call.args(),
  };
}

function simulationWith(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  const base = rawSimulation("ok", [], "1000") as unknown as Record<string, unknown>;
  return {
    ...base,
    results: [{ auth: [], xdr: retval.toXDR("base64") }],
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

export interface FakeEventRequest {
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  topics?: string[][];
}

export function fakeAllowanceRpc(world: FakeAllowancesWorld): AllowanceRpc & {
  eventRequests: FakeEventRequest[];
} {
  const allowances = new Map(world.allowances.map((a) => [`${a.token}:${a.spender}`, a]));
  const eventRequests: FakeEventRequest[] = [];
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
    // Pages like the real RPC: a cursor request carries no end ledger, so events past the
    // requested window's own end still come back and must be dropped by the caller.
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
      const all = window ?? [];
      const limit = r.limit ?? 1_000;
      const page = all.slice(offset, offset + limit);
      const events = page.map((e, i) => ({
        type: "contract",
        ledger: e.ledger,
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        contractId: new Contract(e.token),
        id: `${start}-${offset + i}`,
        pagingToken: `${start}-${offset + i}`,
        inSuccessfulContractCall: true,
        txHash: "00".repeat(32),
        topic: [
          xdr.ScVal.scvSymbol("approve"),
          new Address(OWNER).toScVal(),
          new Address(e.spender).toScVal(),
        ],
        value: xdr.ScVal.scvVec([
          nativeToScVal(e.amount, { type: "i128" }),
          nativeToScVal(e.expirationLedger, { type: "u32" }),
        ]),
        operationIndex: 0,
        transactionIndex: 0,
      }));
      return {
        latestLedger: world.latestLedger ?? 1_000_000,
        events,
        cursor: `${start}/${end}/${offset + page.length}`,
      } as unknown as rpc.Api.GetEventsResponse;
    },
    async simulateTransaction(tx) {
      const call = calledInvocation(tx as Transaction);
      if (!call) return rawSimulation("error", [], "0");
      if (call.fn === "allowance") {
        const spender = Address.fromScVal(call.args[1]!).toString();
        const entry = allowances.get(`${call.contract}:${spender}`);
        if (entry?.hangs) return never as never;
        const amount = entry?.amount ?? 0n;
        return simulationWith(nativeToScVal(amount, { type: "i128" }));
      }
      if (call.fn === "symbol") {
        const entry = [...allowances.values()].find((a) => a.token === call.contract);
        if (entry?.symbolHangs) return never as never;
        if (entry?.symbol === null) return rawSimulation("error", [], "0");
        return simulationWith(nativeToScVal(entry?.symbol ?? "TKN", { type: "string" }));
      }
      return rawSimulation("error", [], "0");
    },
  };
}

export interface FakeAllowancesDepsOptions {
  world: FakeAllowancesWorld;
  budgetMs?: number;
  /** A controllable clock, in ms; advanced by the tests that exercise the budget. */
  clock?: { now: number };
  registryEntries?: ContractRegistryEntry[];
  knownTokens?: string[];
}

export function fakeAllowancesDeps(options: FakeAllowancesDepsOptions): AllowancesDeps & {
  rpc: ReturnType<typeof fakeAllowanceRpc>;
} {
  const rpcStub = fakeAllowanceRpc(options.world);
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  return {
    rpc: rpcStub,
    registryEntries: options.registryEntries ?? [],
    knownTokens: options.knownTokens ?? [],
    now: () => clock.now,
    budgetMs: options.budgetMs ?? 20_000,
  };
}
