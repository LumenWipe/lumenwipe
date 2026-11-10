import { describe, expect, test } from "bun:test";
import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  blendBorrowFits,
  blendReserveFrom,
  readBlendReserve,
  type BlendReserveState,
} from "@/lib/blend-utilization";
import {
  BlendUtilizationError,
  executeMessStep,
  type BuildSignSubmitDeps,
  type MessContext,
} from "@/lib/mess-builders";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import type { ContractCall } from "@/lib/soroban-seed";
import { runMessStep } from "@/lib/session-actions";
import {
  BLEND,
  BLEND_REQUEST,
  BLEND_SEED,
  MAX_SESSION_XLM,
  resolvePlan,
  SCENARIOS,
  validateSelection,
  XLM_SAC,
} from "@/lib/scenarios";
import { seededProtocols } from "@/lib/verify";
import { PINNED_SOROBAN_PROTOCOLS } from "@/lib/verify-soroban";
import { memoryStore, newSessionData } from "./session-fixtures";

// The Blend scenario's seeding, with the network replaced: the one pool call that builds the
// position for each variant, and the utilization read that refuses the borrow before any key signs.

const demo = Keypair.random();

const ctx = (): MessContext => ({
  demo,
  ephemeralIssuers: new Map(),
  persistentIssuer: Keypair.random(),
  mmPublic: Keypair.random().publicKey(),
  transferRecipient: null,
  helpers: new Map(),
  recordSigner: async () => {},
  recordClaimableBalances: async () => {},
  allowances: [],
  recordAllowance: async () => {},
});

const selectionOf = (variant: 0 | 1) => ({
  scenarios: [{ id: "blend-supply" as const, params: { variant } }],
});

const stepOf = (variant: 0 | 1) => resolvePlan(selectionOf(variant)).steps.slice(-1)[0]!;

const RATE = BigInt(10) ** BigInt(12);
const STROOPS = BigInt(10_000_000);

/** A reserve at `util` per ten million of utilization, with a 95% cap and rates of one. */
const reserveAt = (liabilities: bigint, supply: bigint): BlendReserveState => ({
  maxUtil: BigInt(9_500_000),
  bSupply: supply,
  dSupply: liabilities,
  bRate: RATE,
  dRate: RATE,
});

/** Well under the cap: 50% used. */
const ROOMY = reserveAt(BigInt(1_000) * STROOPS, BigInt(2_000) * STROOPS);

interface Run {
  calls: ContractCall[];
  reads: number;
  signed: number;
}

function harness(reserve: BlendReserveState = ROOMY): { run: Run; deps: BuildSignSubmitDeps } {
  const run: Run = { calls: [], reads: 0, signed: 0 };
  return {
    run,
    deps: {
      submit: async () => {
        run.signed++;
        return { txHash: "classic" };
      },
      contractCall: async (_source, call) => {
        run.calls.push(call);
        return { txHash: "soroban-hash" };
      },
      blendReserve: async () => {
        run.reads++;
        return reserve;
      },
    },
  };
}

/** A request as the pool reads it: `{ address, amount, request_type }`, in key order. */
function requestsOf(call: ContractCall): unknown[] {
  const list = call.args[3]!;
  if (list.type !== "scvVec") throw new Error("not a list");
  for (const request of list.vec ?? []) {
    if (request.type !== "scvMap") throw new Error("not a map");
    const keys = (request.map ?? []).map((e) => [
      e.key.type === "scvSymbol" ? e.key.sym.toString() : null,
      e.val.type,
    ]);
    expect(keys).toEqual([
      ["address", "scvAddress"],
      ["amount", "scvI128"],
      ["request_type", "scvU32"],
    ]);
  }
  return scValToNative(list) as unknown[];
}

describe("the pinned pool", () => {
  test("is the registry's testnet Blend pool, and its reserve is XLM", () => {
    expect(BLEND.pool).toBe("CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF");
    expect(BLEND.reserve).toBe(XLM_SAC);
  });

  test("the verifier's Blend row is the pool the seeding supplies, and XLM its only family", () => {
    expect(PINNED_SOROBAN_PROTOCOLS.blend.entry).toEqual([BLEND.pool]);
    expect(PINNED_SOROBAN_PROTOCOLS.blend.family).toEqual([XLM_SAC]);
  });
});

describe("the seeding call", () => {
  test("supply: one submit, the demo on every side, XLM supplied as collateral", async () => {
    const { run, deps } = harness();
    expect(await executeMessStep(stepOf(0), ctx(), deps)).toBe("soroban-hash");
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect([call.contract, call.function]).toEqual([BLEND.pool, "submit"]);
    expect(call.args.slice(0, 3).map((a) => scValToNative(a) as unknown)).toEqual([
      demo.publicKey(),
      demo.publicKey(),
      demo.publicKey(),
    ]);
    expect(requestsOf(call)).toEqual([
      {
        address: XLM_SAC,
        amount: BigInt(BLEND_SEED.supplyXlm) * STROOPS,
        request_type: BLEND_REQUEST.supplyCollateral,
      },
    ]);
    // Nothing is borrowed, so the pool's utilization is never read.
    expect(run.reads).toBe(0);
    expect(run.signed).toBe(0);
  });

  test("supply and borrow: the same supply, then the borrow, in one submit", async () => {
    const { run, deps } = harness();
    await executeMessStep(stepOf(1), ctx(), deps);
    expect(run.calls).toHaveLength(1);
    expect(requestsOf(run.calls[0]!)).toEqual([
      {
        address: XLM_SAC,
        amount: BigInt(BLEND_SEED.supplyXlm) * STROOPS,
        request_type: BLEND_REQUEST.supplyCollateral,
      },
      {
        address: XLM_SAC,
        amount: BigInt(BLEND_SEED.borrowXlm) * STROOPS,
        request_type: BLEND_REQUEST.borrow,
      },
    ]);
    expect(run.reads).toBe(1);
    expect(run.signed).toBe(0);
  });

  test("the seeded protocol carries the variant the selection picked", () => {
    expect(seededProtocols(resolvePlan(selectionOf(0)).steps)).toEqual([
      { protocol: "blend", variant: "supply" },
    ]);
    expect(seededProtocols(resolvePlan(selectionOf(1)).steps)).toEqual([
      { protocol: "blend", variant: "supply_and_borrow" },
    ]);
  });
});

describe("the utilization gate", () => {
  const supply = BigInt(BLEND_SEED.supplyXlm) * STROOPS;
  const borrow = BigInt(BLEND_SEED.borrowXlm) * STROOPS;

  test("a borrow the pool cannot lend is refused before any call is made", async () => {
    const full = reserveAt(BigInt(990) * STROOPS, BigInt(1_000) * STROOPS);
    const { run, deps } = harness(full);
    await expect(executeMessStep(stepOf(1), ctx(), deps)).rejects.toThrow(BlendUtilizationError);
    expect(run.calls).toEqual([]);
    expect(run.signed).toBe(0);
  });

  test("the supply variant never reads it, so a full pool does not stop it", async () => {
    const full = reserveAt(BigInt(999) * STROOPS, BigInt(1_000) * STROOPS);
    const { run, deps } = harness(full);
    await executeMessStep(stepOf(0), ctx(), deps);
    expect(run.reads).toBe(0);
    expect(run.calls).toHaveLength(1);
  });

  test("the utilization counted includes the demo's own supply and borrow", () => {
    // Exactly at the cap once the demo's supply and borrow land: refused.
    const atCap = reserveAt(BigInt(950) * STROOPS - borrow, BigInt(1_000) * STROOPS - supply);
    expect(blendBorrowFits(atCap, supply, borrow)).toBe(false);
    // One stroop of debt less: under the cap, so it fits.
    const under = { ...atCap, dSupply: atCap.dSupply - BigInt(1) };
    expect(blendBorrowFits(under, supply, borrow)).toBe(true);
    // Under the cap before the demo's borrow, at it after: refused.
    const before = reserveAt(BigInt(950) * STROOPS - BigInt(1), BigInt(1_000) * STROOPS - supply);
    expect(blendBorrowFits(before, supply, borrow)).toBe(false);
  });

  test("the rates turn tokens into XLM, liabilities rounded up and supply down", () => {
    // 100 dTokens at 9.5 per token are 950 XLM; 100 bTokens at 10 are 1000.
    const scaled: BlendReserveState = {
      maxUtil: BigInt(9_500_000),
      dSupply: BigInt(100) * STROOPS,
      dRate: (BigInt(95) * RATE) / BigInt(10),
      bSupply: BigInt(100) * STROOPS,
      bRate: BigInt(10) * RATE,
    };
    const fits = (dRate: bigint): boolean =>
      blendBorrowFits({ ...scaled, dRate }, BigInt(0), BigInt(0));
    expect(fits(scaled.dRate)).toBe(false);
    // A fraction of a stroop under the cap rounds up to it: still refused.
    expect(fits(scaled.dRate - BigInt(1))).toBe(false);
    // A whole stroop under it fits.
    expect(fits(scaled.dRate - BigInt(1_000))).toBe(true);
    // Supply rounds down: a fraction of a stroop more supply changes nothing.
    expect(
      blendBorrowFits({ ...scaled, bRate: scaled.bRate + BigInt(1) }, BigInt(0), BigInt(0))
    ).toBe(false);
  });

  test("the reserve is read from the pool's own answer, and an unreadable one is an error", () => {
    const native = {
      asset: XLM_SAC,
      config: { max_util: 9_500_000, c_factor: 9_000_000 },
      data: { b_rate: RATE, b_supply: BigInt(5), d_rate: RATE, d_supply: BigInt(3) },
    };
    expect(blendReserveFrom(native)).toEqual({
      maxUtil: BigInt(9_500_000),
      bSupply: BigInt(5),
      dSupply: BigInt(3),
      bRate: RATE,
      dRate: RATE,
    });
    expect(() => blendReserveFrom({ ...native, data: { ...native.data, d_rate: -1 } })).toThrow();
    expect(() => blendReserveFrom({ config: {} })).toThrow();
  });

  test("the read is one simulated get_reserve of XLM on the pinned pool", async () => {
    const asked: { contract: string; fn: string; args: unknown[] }[] = [];
    const retval = nativeToScVal({
      config: { max_util: nativeToScVal(9_500_000, { type: "u32" }) },
      data: {
        b_rate: nativeToScVal(RATE, { type: "i128" }),
        b_supply: nativeToScVal(BigInt(5), { type: "i128" }),
        d_rate: nativeToScVal(RATE, { type: "i128" }),
        d_supply: nativeToScVal(BigInt(3), { type: "i128" }),
      },
    });
    const reserve = await readBlendReserve({
      simulateTransaction: async (tx) => {
        const op = (tx as { operations: { type: string; func: xdr.HostFunction }[] })
          .operations[0]!;
        if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a call");
        const call = op.func.invokeContract;
        asked.push({
          contract: scValToNative(xdr.ScVal.scvAddress(call.contractAddress)) as string,
          fn: call.functionName.toString(),
          args: call.args.map((a) => scValToNative(a) as unknown),
        });
        return {
          id: "1",
          latestLedger: 1,
          events: [],
          _parsed: true,
          transactionData: undefined,
          minResourceFee: "0",
          result: { auth: [], retval },
        } as never;
      },
    });
    expect(asked).toEqual([{ contract: BLEND.pool, fn: "get_reserve", args: [XLM_SAC] }]);
    expect(reserve.dSupply).toBe(BigInt(3));
  });

  test("a refused borrow is reported in plain language and the step stays undone", async () => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      selection: selectionOf(1),
      completedMessSteps: ["SETUP"],
    });
    const result = await runMessStep(store, session.id, "BLEND_SUBMIT", {
      executeStep: async () => {
        throw new BlendUtilizationError();
      },
    });
    expect(result).toEqual({ status: 503, body: { error: "testnet_lending_unavailable" } });
    expect((await store.loadSession(session.id))?.completedMessSteps).toEqual(["SETUP"]);
    const copy = errorCopy("testnet_lending_unavailable");
    expect(copy).not.toBe(GENERIC_ERROR_COPY);
    expect(copy).toContain("nothing was signed");
  });
});

describe("the cost", () => {
  const own = (variant: 0 | 1) => {
    const def = SCENARIOS.find((d) => d.id === "blend-supply")!;
    const result = def.build({ variant }, { heldAssets: [] });
    if (!result.ok) throw new Error(result.message);
    return result.build.cost;
  };

  test("the supplied XLM locked, and the fee ceiling of the seeding call and of each exit", () => {
    // Supply: the seeding call and one exit. Borrow: a repay before the withdrawal.
    expect(own(0).xlm).toBe(Number(BLEND_SEED.supplyXlm) + 2);
    expect(own(1).xlm).toBe(Number(BLEND_SEED.supplyXlm) + 3);
    for (const variant of [0, 1] as const) {
      // One contract transaction to seed it, as every protocol scenario counts its seeding, and
      // no entry on the account.
      expect(own(variant)).toMatchObject({
        classicTransactions: 0,
        sorobanTransactions: 1,
        subEntries: 0,
      });
      const result = validateSelection(selectionOf(variant));
      if (!result.ok) throw new Error(result.message);
      expect(result.plan.cost.xlm).toBeLessThanOrEqual(MAX_SESSION_XLM);
    }
  });
});
