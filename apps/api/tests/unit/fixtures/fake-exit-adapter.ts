/**
 * A reference exit adapter and a fake RPC, for proving the runner and the invariant harness.
 *
 * The adapter is a minimal Blend-supply-shaped implementation with knobs that make it break one
 * invariant at a time, so the suite can show each violation is caught from outside the adapter.
 * It is not a preview of the real Blend adapter (#154): it invokes a `withdraw` with a made-up
 * argument shape, on purpose, so nobody mistakes it for one.
 */
import {
  Account,
  Address,
  Asset,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type rpc,
  Transaction,
} from "@stellar/stellar-sdk";
import type { BlendSupplyPosition, DefiPosition } from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type {
  BuiltExitStep,
  ExitAdapter,
  ExitContext,
  ExitPlan,
  ExitRpc,
  ExitStep,
  ExitStepKind,
} from "@/lib/defi-exits";
import { MIN_RECEIVED_REQUIRED, clampToBalance, minReceivedFromQuote } from "@/lib/defi-exits";
import { contractDataKey, symbolVal } from "@/lib/defi-positions/testnet-direct-read";

export const POSITION_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
export const OTHER_CONTRACT = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
export const OTHER_ACCOUNT = Keypair.random().publicKey();

export interface FakeLiveState {
  /** Live supplied balance, base units. */
  balance: string;
}

export interface FakeAdapterKnobs {
  /** The main step's kind (default "withdraw"). */
  kind?: ExitStepKind;
  /** Report debt of 50 (in collateral units) against the live balance read as collateral, and
   *  plan a repay ahead of the main step. Health follows the live state: 75 collateral is
   *  healthy against a 110% threshold, 52 is not. */
  debt?: boolean;
  /** Report debt but plan no repay. */
  skipRepayWithDebt?: boolean;
  /** Plan an amount above the live balance. */
  overWithdraw?: boolean;
  /** Plan a price-dependent step with no floor. */
  omitMinReceived?: boolean;
  /** Plan a price-dependent step whose floor is zero. */
  zeroMinReceived?: boolean;
  /** Plan the main step ahead of the repay. */
  withdrawBeforeRepay?: boolean;
  /** Describe the invocation as a different function than the one built. */
  lieInIntent?: boolean;
  /** Describe the proceeds as going to another account. */
  lieRecipient?: boolean;
  /** Build a classic payment instead of a contract invocation. */
  buildClassicOp?: boolean;
  /** Build the invocation with another account as its source. */
  foreignSource?: boolean;
  /** Return neither steps nor blockers. */
  emptyPlan?: boolean;
  /** Throw from plan(). */
  throwInPlan?: boolean;
  /** Plan an amount that is not a base-unit integer. */
  malformedAmount?: boolean;
  /** Add a second step against OTHER_CONTRACT. */
  foreignContractStep?: boolean;
  /** Return the step as an externally built envelope instead of a local operation. */
  external?: boolean;
  /** The external envelope carries two operations. */
  externalTwoOps?: boolean;
  /** Throw from the post-assembly hook. */
  hardenThrows?: boolean;
  /** Have the post-assembly hook swap the invocation for a call to another function. */
  hardenChangesCall?: boolean;
  /** Have the post-assembly hook keep the call but change its amount argument. */
  hardenChangesArgs?: boolean;
  /** Have the post-assembly hook move the time bounds. */
  hardenChangesTimeBounds?: boolean;
  /** Have the post-assembly hook bump the resource fee by this many stroops. */
  hardenAddsFee?: bigint;
}

export function balanceKey(contract: string): xdr.LedgerKey {
  return contractDataKey(contract, symbolVal("Balance"));
}

function invocation(step: ExitStep, ctx: ExitContext, source?: string): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: step.contract,
    function: step.function,
    args: [
      new Address(ctx.account).toScVal(),
      nativeToScVal(BigInt(step.amount), { type: "i128" }),
    ],
    ...(source ? { source } : {}),
  });
}

export function fakeExitAdapter(
  knobs: FakeAdapterKnobs = {}
): ExitAdapter<BlendSupplyPosition, FakeLiveState> {
  const kind = knobs.kind ?? "withdraw";
  const reportsDebt = knobs.debt || knobs.skipRepayWithDebt;

  return {
    protocol: "blend",

    supports(position: DefiPosition): position is BlendSupplyPosition {
      return position.protocol === "blend" && position.positionType === "supply";
    },

    async readLive(position, _code, _ctx, rpc: ExitRpc): Promise<FakeLiveState> {
      const res = await rpc.getLedgerEntries(balanceKey(position.contractAddress));
      const entry = res.entries?.[0];
      if (!entry) throw new Error("fake adapter: no live balance entry");
      const native: unknown = scValToNative(entry.val.contractData().val());
      return { balance: String(native) };
    },

    plan(position, live, _code, ctx): ExitPlan {
      if (knobs.throwInPlan) throw new Error("fake adapter: plan exploded");
      if (knobs.emptyPlan) return { steps: [], blockers: [] };
      const requested = knobs.overWithdraw
        ? (BigInt(live.balance) + 1n).toString()
        : clampToBalance(position.bTokenAmount, live.balance);
      const floors = MIN_RECEIVED_REQUIRED.includes(kind)
        ? knobs.omitMinReceived
          ? []
          : [
              {
                asset: "native",
                amount: knobs.zeroMinReceived
                  ? "0"
                  : minReceivedFromQuote(requested, ctx.slippageBps),
              },
            ]
        : [];
      const main: ExitStep = {
        kind,
        contract: position.contractAddress,
        function: kind,
        asset: position.assetAddress,
        amount: knobs.malformedAmount ? "1.5" : requested,
        ceiling: live.balance,
        minReceived: floors,
        description: `${kind} ${requested} base units from ${position.contractAddress}`,
      };
      const repay: ExitStep = {
        ...main,
        kind: "repay",
        function: "repay",
        amount: "1000",
        ceiling: "1000",
        minReceived: [],
        description: "repay 1000 base units of debt",
      };
      const steps: ExitStep[] = [];
      if (knobs.withdrawBeforeRepay) steps.push(main, repay);
      else if (reportsDebt && !knobs.skipRepayWithDebt) steps.push(repay, main);
      else steps.push(main);
      if (knobs.foreignContractStep) {
        steps.push({
          ...main,
          kind: "claim",
          function: "claim",
          contract: OTHER_CONTRACT,
          minReceived: [],
          description: "claim rewards",
        });
      }
      return { steps, blockers: [] };
    },

    health(_position, live) {
      if (!reportsDebt) return null;
      // The live balance read as collateral, in whole units (7 decimals), against a fixed debt.
      const balance = BigInt(live.balance);
      const whole = balance / 10_000_000n;
      const fraction = (balance % 10_000_000n).toString().padStart(7, "0");
      return {
        collateralValue: `${whole}.${fraction}`,
        debtValue: "50",
        minHealthFactorBps: 11_000,
      };
    },

    buildStep(step, _live, ctx): BuiltExitStep {
      const op = knobs.buildClassicOp
        ? Operation.payment({ destination: ctx.account, asset: Asset.native(), amount: "1" })
        : invocation(step, ctx, knobs.foreignSource ? OTHER_ACCOUNT : undefined);
      const intent = {
        contract: step.contract,
        function: knobs.lieInIntent ? "claim" : step.function,
        args: [ctx.account, step.amount],
        minReceived: step.minReceived,
        recipient: knobs.lieRecipient ? OTHER_ACCOUNT : ctx.account,
      };
      if (knobs.external) {
        const builder = new TransactionBuilder(new Account(ctx.account, ctx.sequence), {
          fee: "100",
          networkPassphrase: NETWORK_PASSPHRASES[ctx.network],
        }).addOperation(op);
        if (knobs.externalTwoOps) builder.addOperation(op);
        const envelopeXdr = builder.setTimeout(300).build().toXDR();
        return { step, build: { source: "external", provider: "fake-api", envelopeXdr }, intent };
      }
      return { step, build: { source: "local", op }, intent };
    },

    ...(knobs.hardenThrows ||
    knobs.hardenChangesCall ||
    knobs.hardenChangesArgs ||
    knobs.hardenChangesTimeBounds ||
    knobs.hardenAddsFee !== undefined
      ? {
          hardenBuilt(tx: Transaction, step: ExitStep, _live: FakeLiveState, ctx: ExitContext) {
            if (knobs.hardenThrows) throw new Error("fake adapter: harden exploded");
            const data = tx.toEnvelope().v1().tx().ext().sorobanData();
            const resourceFee = data.resourceFee().toBigInt();
            const sorobanData = new SorobanDataBuilder(data)
              .setResourceFee(resourceFee + (knobs.hardenAddsFee ?? 0n))
              .build();
            const builder = TransactionBuilder.cloneFrom(tx, {
              fee: (BigInt(tx.fee) - resourceFee).toString(),
              sorobanData,
            });
            if (knobs.hardenChangesCall) {
              builder.clearOperations();
              builder.addOperation(invocation({ ...step, function: "claim" }, ctx));
            }
            if (knobs.hardenChangesArgs) {
              builder.clearOperations();
              builder.addOperation(invocation({ ...step, amount: "1" }, ctx));
            }
            const built = builder.build();
            if (!knobs.hardenChangesTimeBounds) return built;
            // The builder refuses to overwrite bounds; a hook bent on it can still edit the XDR.
            const envelope = built.toEnvelope();
            envelope
              .v1()
              .tx()
              .cond(
                xdr.Preconditions.precondTime(
                  new xdr.TimeBounds({
                    minTime: xdr.Uint64.fromString("0"),
                    maxTime: xdr.Uint64.fromString(String(Math.floor(Date.now() / 1000) + 3_600)),
                  })
                )
              );
            return new Transaction(envelope, built.networkPassphrase);
          },
        }
      : {}),
  };
}

// ─── Fake RPC ────────────────────────────────────────────────────────────────

export interface FakeRpcOptions {
  /** What a contract instance reports as its code hash; null means "contract not found". */
  liveWasmHash: string | null;
  /** Per-contract overrides of `liveWasmHash`. */
  hashesByContract?: Record<string, string | null>;
  /** Live balance the fake adapter reads, base units. */
  liveBalance: string;
  simulation?: "ok" | "error" | "restore";
  /** Authorization entries the simulation "discovers" (base64 SorobanAuthorizationEntry). */
  simulatedAuth?: string[];
  /** The resource fee the simulation prices, stroops. */
  simulatedResourceFee?: string;
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

const BALANCE_KEY_XDR = symbolVal("Balance").toXDR("base64");

/** Raw (unparsed) simulation responses, the shape the SDK's own parser and assembler accept. */
export function rawSimulation(
  mode: "ok" | "error" | "restore",
  auth: string[],
  minResourceFee: string
): rpc.Api.SimulateTransactionResponse {
  const transactionData = new SorobanDataBuilder()
    .setResourceFee(BigInt(minResourceFee))
    .build()
    .toXDR("base64");
  const base = { id: "1", latestLedger: 1, events: [] as string[] };
  const body =
    mode === "error"
      ? { ...base, error: "HostError: Error(Contract, #3)" }
      : {
          ...base,
          minResourceFee,
          transactionData,
          results: [{ auth, xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
          ...(mode === "restore"
            ? { restorePreamble: { minResourceFee: "500", transactionData } }
            : {}),
        };
  return body as unknown as rpc.Api.SimulateTransactionResponse;
}

/** Serves each contract's instance entry (or nothing) and one Balance entry, by exact key. */
export function fakeExitRpc(options: FakeRpcOptions): ExitRpc & { simulateCalls: Transaction[] } {
  const simulateCalls: Transaction[] = [];
  const hashFor = (contract: string): string | null =>
    options.hashesByContract && contract in options.hashesByContract
      ? options.hashesByContract[contract]!
      : options.liveWasmHash;

  return {
    simulateCalls,
    async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
      const entries = keys.flatMap((key) => {
        if (key.switch() !== xdr.LedgerEntryType.contractData()) return [];
        const data = key.contractData();
        const contract = Address.fromScAddress(data.contract()).toString();
        let val: xdr.LedgerEntryData | null = null;
        if (data.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
          const hash = hashFor(contract);
          val = hash === null ? null : instanceEntry(contract, hash);
        } else if (data.key().toXDR("base64") === BALANCE_KEY_XDR) {
          val = balanceEntry(contract, options.liveBalance);
        }
        return val ? [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 }] : [];
      });
      return { latestLedger: 1, entries };
    },
    async simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
      simulateCalls.push(tx);
      return rawSimulation(
        options.simulation ?? "ok",
        options.simulatedAuth ?? [],
        options.simulatedResourceFee ?? "12345"
      );
    },
  };
}

export function fakeSupplyPosition(
  overrides: Partial<BlendSupplyPosition> = {}
): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: POSITION_CONTRACT,
    assetAddress: OTHER_CONTRACT,
    bTokenAmount: "1000000000",
    usdValue: null,
    ...overrides,
  };
}
