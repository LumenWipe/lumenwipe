/**
 * A reference exit adapter and a fake RPC, for proving the runner and the invariant harness.
 *
 * The adapter is a minimal Blend-supply-shaped implementation with knobs that make it break one
 * invariant at a time, so the suite can show each violation is caught from outside the adapter.
 * It is not a preview of the real Blend adapter (#154): it invokes a `withdraw` with a made-up
 * argument shape, on purpose, so nobody mistakes it for one.
 */
import {
  Address,
  Asset,
  Operation,
  nativeToScVal,
  scValToNative,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { BlendSupplyPosition, DefiPosition } from "@lumenwipe/types";
import type {
  BuiltExitStep,
  ExitAdapter,
  ExitContext,
  ExitPlan,
  ExitRpc,
  ExitStep,
  ExitStepKind,
} from "@/lib/defi-exits";
import { clampToBalance, minReceivedFromQuote } from "@/lib/defi-exits";
import { contractDataKey, symbolVal } from "@/lib/defi-positions/testnet-direct-read";

export interface FakeLiveState {
  /** Live supplied balance, base units. */
  balance: string;
}

export interface FakeAdapterKnobs {
  /** Plan an amount above the live balance (violates clamp-to-balance). */
  overWithdraw?: boolean;
  /** Plan a price-dependent step with no floor (violates minimum-received). */
  omitMinReceived?: boolean;
  /** Plan a withdraw ahead of a repay (violates repay-before-withdraw). */
  withdrawBeforeRepay?: boolean;
  /** Describe the invocation as a different function than the one built (intent lies). */
  lieInIntent?: boolean;
  /** Build a classic payment instead of a contract invocation. */
  buildClassicOp?: boolean;
  /** Return neither steps nor blockers. */
  emptyPlan?: boolean;
  /** Read live state, then plan a step of a configurable kind (default "withdraw"). */
  kind?: ExitStepKind;
}

export function balanceKey(contract: string): xdr.LedgerKey {
  return contractDataKey(contract, symbolVal("Balance"));
}

export function fakeExitAdapter(
  knobs: FakeAdapterKnobs = {}
): ExitAdapter<BlendSupplyPosition, FakeLiveState> {
  const kind = knobs.kind ?? "withdraw";
  return {
    protocol: "blend",

    supports(position: DefiPosition): position is BlendSupplyPosition {
      return position.protocol === "blend" && position.positionType === "supply";
    },

    async readLive(position, _ctx, rpc: ExitRpc): Promise<FakeLiveState> {
      const res = await rpc.getLedgerEntries(balanceKey(position.contractAddress));
      const entry = res.entries?.[0];
      if (!entry) throw new Error("fake adapter: no live balance entry");
      const native: unknown = scValToNative(entry.val.contractData().val());
      return { balance: String(native) };
    },

    plan(position, live, ctx): ExitPlan {
      if (knobs.emptyPlan) return { steps: [], blockers: [] };
      const requested = knobs.overWithdraw
        ? (BigInt(live.balance) + 1n).toString()
        : clampToBalance(position.bTokenAmount, live.balance);
      const step: ExitStep = {
        kind,
        contract: position.contractAddress,
        function: kind,
        amount: requested,
        ceiling: live.balance,
        minReceived:
          knobs.omitMinReceived || kind === "withdraw" || kind === "repay"
            ? null
            : { asset: "native", amount: minReceivedFromQuote(requested, ctx.slippageBps) },
        description: `${kind} ${requested} base units from ${position.contractAddress}`,
      };
      if (knobs.withdrawBeforeRepay) {
        const repay: ExitStep = { ...step, kind: "repay", function: "repay", minReceived: null };
        return { steps: [step, repay], blockers: [] };
      }
      return { steps: [step], blockers: [] };
    },

    buildStep(step, _live, ctx): BuiltExitStep {
      const op = knobs.buildClassicOp
        ? Operation.payment({ destination: ctx.account, asset: Asset.native(), amount: "1" })
        : Operation.invokeContractFunction({
            contract: step.contract,
            function: step.function,
            args: [
              new Address(ctx.account).toScVal(),
              nativeToScVal(BigInt(step.amount), { type: "i128" }),
            ],
          });
      return {
        step,
        op,
        intent: {
          contract: step.contract,
          function: knobs.lieInIntent ? "claim" : step.function,
          args: [ctx.account, step.amount],
          minReceived: step.minReceived,
          recipient: ctx.account,
        },
      };
    },
  };
}

// ─── Fake RPC ────────────────────────────────────────────────────────────────

export interface FakeRpcOptions {
  /** What the contract instance reports as its code hash; null means "contract not found". */
  liveWasmHash: string | null;
  /** Live balance the fake adapter reads, base units. */
  liveBalance: string;
  simulation?: "ok" | "error";
}

function instanceEntry(contract: string, wasmHash: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHash, "hex")),
          storage: null,
        })
      ),
    })
  );
}

function balanceEntry(contract: string, balance: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: symbolVal("Balance"),
      durability: xdr.ContractDataDurability.persistent(),
      val: nativeToScVal(BigInt(balance), { type: "i128" }),
    })
  );
}

function isInstanceKey(key: xdr.LedgerKey): boolean {
  return (
    key.switch() === xdr.LedgerEntryType.contractData() &&
    key.contractData().key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()
  );
}

/** Serves the instance entry (or nothing) and one Balance entry for whichever contract is asked. */
export function fakeExitRpc(options: FakeRpcOptions): ExitRpc & { simulateCalls: Transaction[] } {
  const simulateCalls: Transaction[] = [];
  return {
    simulateCalls,
    async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
      const entries = keys.flatMap((key) => {
        const contract = Address.fromScAddress(key.contractData().contract()).toString();
        const val = isInstanceKey(key)
          ? options.liveWasmHash === null
            ? null
            : instanceEntry(contract, options.liveWasmHash)
          : balanceEntry(contract, options.liveBalance);
        return val ? [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 }] : [];
      });
      return { latestLedger: 1, entries };
    },
    async simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
      simulateCalls.push(tx);
      if (options.simulation === "error") {
        return {
          id: "1",
          latestLedger: 1,
          events: [],
          error: "HostError: Error(Contract, #3)",
        } as unknown as rpc.Api.SimulateTransactionErrorResponse;
      }
      return {
        id: "1",
        latestLedger: 1,
        events: [],
        minResourceFee: "12345",
        transactionData: undefined,
        result: undefined,
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
    },
  };
}

export function fakeSupplyPosition(
  overrides: Partial<BlendSupplyPosition> = {}
): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    assetAddress: "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V",
    bTokenAmount: "1000000000",
    usdValue: null,
    ...overrides,
  };
}
