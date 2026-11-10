import { describe, expect, test } from "bun:test";
import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { exitExpectations } from "@lumenwipe/verify";
import {
  executeMessStep,
  LiquidityUnavailableError,
  phoenixBondShares,
  type BuildSignSubmitDeps,
  type MessContext,
} from "@/lib/mess-builders";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  phoenixDepositXlm,
  phoenixReads,
  phoenixReservesFrom,
  phoenixSwapFits,
  phoenixSwapFloor,
  phoenixSwapQuoteFrom,
  type PhoenixReads,
  type PhoenixReserves,
  type PhoenixSwapQuote,
} from "@/lib/phoenix-pool";
import type { ContractCall } from "@/lib/soroban-seed";
import { runMessStep } from "@/lib/session-actions";
import {
  MAX_SESSION_XLM,
  MAX_SOROBAN_TRANSACTIONS,
  PHOENIX,
  PHOENIX_SEED,
  resolvePlan,
  SCENARIOS,
  validateSelection,
  XLM_SAC,
  type MessStepDef,
  type MessStepId,
} from "@/lib/scenarios";
import { seededProtocols } from "@/lib/verify";
import { PINNED_SOROBAN_PROTOCOLS } from "@/lib/verify-soroban";
import { memoryStore, newSessionData } from "./session-fixtures";

// The Phoenix scenario's seeding, with the network replaced: the simulated swap that must show
// enough LWPHX at a small enough spread before any key signs, the swap and the deposit sized from
// live reads, and the bond of exactly half the shares.

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
  scenarios: [{ id: "phoenix-lp" as const, params: { variant } }],
});

const stepOf = (variant: 0 | 1, id: MessStepId): MessStepDef =>
  resolvePlan(selectionOf(variant)).steps.find((s) => s.id === id)!;

const STROOPS = BigInt(10_000_000);
const OFFER = BigInt(5_000_000);

/** What testnet quoted for 0.5 XLM on 2026-11-10: about 70 bps of spread. */
const QUOTE: PhoenixSwapQuote = { askAmount: BigInt(4_711_568), spreadAmount: BigInt(33_279) };
/** The pool's reserves that day. */
const RESERVES: PhoenixReserves = {
  reserveA: BigInt(675_785_099),
  reserveB: BigInt(710_003_810),
};
/** What the demo holds once the swap lands, less than the quote's floor would allow. */
const LIVE_LWPHX = BigInt(4_700_001);
const LIVE_SHARES = BigInt(4_812_345);

interface Run {
  calls: ContractCall[];
  reads: string[];
  signed: number;
}

function harness(over: Partial<{ quote: PhoenixSwapQuote; lwphx: bigint; shares: bigint }> = {}): {
  run: Run;
  deps: BuildSignSubmitDeps;
} {
  const run: Run = { calls: [], reads: [], signed: 0 };
  const reads: PhoenixReads = {
    swapQuote: async (offer) => {
      run.reads.push(`swap:${offer}`);
      return over.quote ?? QUOTE;
    },
    reserves: async () => {
      run.reads.push("reserves");
      return RESERVES;
    },
    balance: async (token, account) => {
      run.reads.push(`balance:${token}:${account}`);
      return token === PHOENIX.tokenA
        ? (over.lwphx ?? LIVE_LWPHX)
        : token === PHOENIX.shareToken
          ? (over.shares ?? LIVE_SHARES)
          : BigInt(0);
    },
  };
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
      phoenix: reads,
    },
  };
}

/** A call's arguments as their ScVal types and native values. */
const shapeOf = (call: ContractCall): [string, unknown][] =>
  call.args.map((a) => [a.type, scValToNative(a) as unknown]);

describe("the pinned pool", () => {
  test("is the registry's testnet Phoenix pool, its stake, its tokens and its share token", () => {
    expect(PHOENIX).toEqual({
      pool: "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV",
      stake: "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP",
      tokenA: "CDI3UIVKFNJAFBWOUMWQ6AO34BQ5JMFBHG4EUB3ZVKCKH5FINXE6QGGZ",
      tokenB: XLM_SAC,
      shareToken: "CC53IRMBHWTXE4BWPD5N4LH2L43YSYBMOFD6UARPMZBTWPSODFFKW2EG",
    });
  });

  test("the bundled registry names the pool and the stake, never a token", () => {
    const { registryContracts } = exitExpectations(null, "testnet");
    expect(registryContracts).toContain(PHOENIX.pool);
    expect(registryContracts).toContain(PHOENIX.stake);
    expect(registryContracts).not.toContain(PHOENIX.tokenA);
    expect(registryContracts).not.toContain(PHOENIX.shareToken);
  });

  test("the verifier's Phoenix row is the pool and the stake, and the share token its only family", () => {
    expect(PINNED_SOROBAN_PROTOCOLS.phoenix.entry).toEqual([PHOENIX.pool, PHOENIX.stake]);
    expect(PINNED_SOROBAN_PROTOCOLS.phoenix.family).toEqual([PHOENIX.shareToken]);
  });

  test("the plan swaps, deposits, and bonds only in the bonded variant", () => {
    const ids = (variant: 0 | 1) => resolvePlan(selectionOf(variant)).steps.map((s) => s.id);
    expect(ids(0)).toEqual(["SETUP", "PHOENIX_SWAP", "PHOENIX_PROVIDE"]);
    expect(ids(1)).toEqual(["SETUP", "PHOENIX_SWAP", "PHOENIX_PROVIDE", "PHOENIX_BOND"]);
  });
});

describe("the swap", () => {
  test("is one pool swap of 0.5 XLM, floored 1% under the quote, with the spread bound", async () => {
    const { run, deps } = harness();
    expect(await executeMessStep(stepOf(0, "PHOENIX_SWAP"), ctx(), deps)).toBe("soroban-hash");
    expect(run.reads).toEqual([`swap:${OFFER}`]);
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect([call.contract, call.function]).toEqual([PHOENIX.pool, "swap"]);
    const floor = (QUOTE.askAmount * BigInt(99)) / BigInt(100);
    expect(shapeOf(call)).toEqual([
      ["scvAddress", demo.publicKey()],
      ["scvAddress", XLM_SAC],
      ["scvI128", OFFER],
      ["scvI128", floor],
      ["scvI64", BigInt(300)],
      ["scvVoid", null],
      ["scvVoid", null],
    ]);
    expect(phoenixSwapFloor(QUOTE)).toBe(floor);
    expect(run.signed).toBe(0);
  });

  test("a quote under 10,000 base units of LWPHX is refused before any call is made", async () => {
    const thin = { askAmount: BigInt(9_999), spreadAmount: BigInt(0) };
    const { run, deps } = harness({ quote: thin });
    await expect(executeMessStep(stepOf(0, "PHOENIX_SWAP"), ctx(), deps)).rejects.toThrow(
      LiquidityUnavailableError
    );
    expect(run.calls).toEqual([]);
    expect(run.signed).toBe(0);
    expect(phoenixSwapFits({ askAmount: BigInt(10_000), spreadAmount: BigInt(0) })).toBe(true);
  });

  test("a spread over 300 bps is refused before any call is made", async () => {
    // 301 of every 10,000 the swap would return without the spread.
    const wide = { askAmount: BigInt(9_699_000), spreadAmount: BigInt(301_000) };
    const { run, deps } = harness({ quote: wide });
    await expect(executeMessStep(stepOf(0, "PHOENIX_SWAP"), ctx(), deps)).rejects.toThrow(
      LiquidityUnavailableError
    );
    expect(run.calls).toEqual([]);
    // Exactly 300 bps is accepted, one base unit more is not.
    expect(phoenixSwapFits({ askAmount: BigInt(9_700_000), spreadAmount: BigInt(300_000) })).toBe(
      true
    );
    expect(phoenixSwapFits({ askAmount: BigInt(9_699_999), spreadAmount: BigInt(300_001) })).toBe(
      false
    );
  });

  test("a refused swap is reported in plain language and the step stays undone", async () => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      selection: selectionOf(0),
      completedMessSteps: ["SETUP"],
    });
    const result = await runMessStep(store, session.id, "PHOENIX_SWAP", {
      executeStep: async () => {
        throw new LiquidityUnavailableError("phoenix-lwphx");
      },
    });
    expect(result).toEqual({ status: 503, body: { error: "testnet_liquidity_unavailable" } });
    expect((await store.loadSession(session.id))?.completedMessSteps).toEqual(["SETUP"]);
    const copy = errorCopy("testnet_liquidity_unavailable");
    expect(copy).not.toBe(GENERIC_ERROR_COPY);
    expect(copy).toContain("nothing was signed");
    expect(copy).not.toContain("USDC");
  });
});

describe("the deposit", () => {
  test("pairs the whole live LWPHX balance with the XLM its ratio needs, plus 2%", async () => {
    const { run, deps } = harness();
    await executeMessStep(stepOf(0, "PHOENIX_PROVIDE"), ctx(), deps);
    expect(run.reads).toEqual(["reserves", `balance:${PHOENIX.tokenA}:${demo.publicKey()}`]);
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect([call.contract, call.function]).toEqual([PHOENIX.pool, "provide_liquidity"]);
    const needed = (LIVE_LWPHX * RESERVES.reserveB) / RESERVES.reserveA;
    const xlm = (needed * BigInt(102)) / BigInt(100);
    expect(shapeOf(call)).toEqual([
      ["scvAddress", demo.publicKey()],
      ["scvI128", LIVE_LWPHX],
      ["scvI128", BigInt(1)],
      ["scvI128", xlm],
      ["scvI128", BigInt(1)],
      ["scvI64", BigInt(500)],
      ["scvVoid", null],
    ]);
    expect(run.signed).toBe(0);
  });

  test("the XLM offered never passes 1 XLM, however much LWPHX there is", () => {
    const cap = BigInt(PHOENIX_SEED.depositMaxXlm) * STROOPS;
    expect(phoenixDepositXlm(BigInt(100) * STROOPS, RESERVES, cap)).toBe(cap);
    expect(phoenixDepositXlm(BigInt(1_000), RESERVES, cap)).toBeLessThan(cap);
    expect(() =>
      phoenixDepositXlm(BigInt(1), { reserveA: BigInt(0), reserveB: BigInt(1) }, cap)
    ).toThrow();
  });

  test("a demo with no LWPHX signs nothing", async () => {
    const { run, deps } = harness({ lwphx: BigInt(0) });
    await expect(executeMessStep(stepOf(0, "PHOENIX_PROVIDE"), ctx(), deps)).rejects.toThrow();
    expect(run.calls).toEqual([]);
  });
});

describe("the bond", () => {
  test("bonds exactly half the live share balance on the stake, so a plain balance is left", async () => {
    const { run, deps } = harness();
    await executeMessStep(stepOf(1, "PHOENIX_BOND"), ctx(), deps);
    expect(run.reads).toEqual([`balance:${PHOENIX.shareToken}:${demo.publicKey()}`]);
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect([call.contract, call.function]).toEqual([PHOENIX.stake, "bond"]);
    const bonded = LIVE_SHARES / BigInt(2);
    expect(shapeOf(call)).toEqual([
      ["scvAddress", demo.publicKey()],
      ["scvI128", bonded],
    ]);
    // The API's testnet read finds the position by the plain balance (#870), so it must stay.
    expect(LIVE_SHARES - bonded).toBeGreaterThan(BigInt(0));
  });

  test("half is rounded down, and a balance too small to halve signs nothing", async () => {
    for (const shares of [BigInt(2), BigInt(3), BigInt(1_000_001)]) {
      expect(phoenixBondShares(shares)).toBe(shares / BigInt(2));
      expect(shares - phoenixBondShares(shares)).toBeGreaterThan(BigInt(0));
    }
    const { run, deps } = harness({ shares: BigInt(1) });
    await expect(executeMessStep(stepOf(1, "PHOENIX_BOND"), ctx(), deps)).rejects.toThrow();
    expect(run.calls).toEqual([]);
  });

  test("the seeded protocol carries the variant the selection picked", () => {
    expect(seededProtocols(resolvePlan(selectionOf(0)).steps)).toEqual([
      { protocol: "phoenix", variant: "lp" },
    ]);
    expect(seededProtocols(resolvePlan(selectionOf(1)).steps)).toEqual([
      { protocol: "phoenix", variant: "bonded" },
    ]);
  });
});

describe("the reads", () => {
  interface Asked {
    contract: string;
    fn: string;
    args: unknown[];
  }

  function simulator(retval: xdr.ScVal, asked: Asked[]) {
    return {
      simulateTransaction: async (tx: unknown) => {
        const op = (tx as { operations: { func: xdr.HostFunction }[] }).operations[0]!;
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
    };
  }

  const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

  test("the swap quote is one simulated simulate_swap of XLM on the pinned pool", async () => {
    const asked: Asked[] = [];
    const retval = nativeToScVal({
      ask_amount: i128(BigInt(4_711_568)),
      commission_amount: i128(BigInt(14_177)),
      spread_amount: i128(BigInt(33_279)),
      total_return: i128(BigInt(4_759_024)),
    });
    const quote = await phoenixReads(simulator(retval, asked)).swapQuote(OFFER);
    expect(asked).toEqual([
      { contract: PHOENIX.pool, fn: "simulate_swap", args: [XLM_SAC, OFFER] },
    ]);
    expect(quote).toEqual(QUOTE);
  });

  test("the reserves are the pool's own, and a pool naming other tokens is an error", async () => {
    const asked: Asked[] = [];
    const info = (a: string) =>
      nativeToScVal({
        asset_a: { address: nativeToScVal(a, { type: "address" }), amount: i128(BigInt(7)) },
        asset_b: { address: nativeToScVal(XLM_SAC, { type: "address" }), amount: i128(BigInt(9)) },
      });
    const reserves = await phoenixReads(simulator(info(PHOENIX.tokenA), asked)).reserves();
    expect(asked).toEqual([{ contract: PHOENIX.pool, fn: "query_pool_info", args: [] }]);
    expect(reserves).toEqual({ reserveA: BigInt(7), reserveB: BigInt(9) });
    await expect(
      phoenixReads(simulator(info(PHOENIX.shareToken), [])).reserves()
    ).rejects.toThrow();
  });

  test("a balance is one simulated balance(id) on the token", async () => {
    const asked: Asked[] = [];
    const balance = await phoenixReads(simulator(i128(BigInt(42)), asked)).balance(
      PHOENIX.shareToken,
      demo.publicKey()
    );
    expect(asked).toEqual([
      { contract: PHOENIX.shareToken, fn: "balance", args: [demo.publicKey()] },
    ]);
    expect(balance).toBe(BigInt(42));
  });

  test("an unreadable answer is an error, never a zero", () => {
    expect(() =>
      phoenixSwapQuoteFrom({ ask_amount: BigInt(-1), spread_amount: BigInt(0) })
    ).toThrow();
    expect(() => phoenixSwapQuoteFrom(null)).toThrow();
    expect(() => phoenixReservesFrom({})).toThrow();
  });
});

describe("the cost", () => {
  const own = (variant: 0 | 1) => {
    const def = SCENARIOS.find((d) => d.id === "phoenix-lp")!;
    const result = def.build({ variant }, { heldAssets: [] });
    if (!result.ok) throw new Error(result.message);
    return result.build.cost;
  };

  test("the XLM swapped and paired, and the fee ceiling of every seeding call and exit", () => {
    // lp: the swap and the deposit, then the withdrawal. bonded: the bond, then the unbond too.
    expect(own(0)).toMatchObject({ xlm: 4.5, sorobanTransactions: 2, classicTransactions: 0 });
    expect(own(1)).toMatchObject({ xlm: 6.5, sorobanTransactions: 3, classicTransactions: 0 });
    for (const variant of [0, 1] as const) {
      expect(own(variant).subEntries).toBe(0);
      const result = validateSelection(selectionOf(variant));
      if (!result.ok) throw new Error(result.message);
      expect(result.plan.cost.xlm).toBeLessThanOrEqual(MAX_SESSION_XLM);
      expect(result.plan.cost.sorobanTransactions).toBeLessThanOrEqual(MAX_SOROBAN_TRANSACTIONS);
    }
  });
});
