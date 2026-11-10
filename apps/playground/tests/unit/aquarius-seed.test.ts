import { describe, expect, test } from "bun:test";
import {
  Asset,
  Keypair,
  Networks,
  scValToNative,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  executeMessStep,
  type BuildSignSubmitDeps,
  type BuyQuote,
  type MessContext,
} from "@/lib/mess-builders";
import type { ContractCall } from "@/lib/soroban-seed";
import {
  AQUARIUS,
  AQUARIUS_SEED,
  BASE_RESERVE_XLM,
  PINNED_ASSETS,
  PURCHASE_OWNER,
  purchaseBuild,
  resolvePlan,
  SOROSWAP_SEED,
  XLM_SAC,
  type MessStepId,
  type ScenarioId,
} from "@/lib/scenarios";
import { PINNED_SOROBAN_PROTOCOLS } from "@/lib/verify-soroban";

// The Aquarius scenario's seeding, with the network replaced: the one router call that builds the
// position, and the USDC purchase it shares with the Soroswap scenario, made once for both.

const demo = Keypair.random();
const CIRCLE = PINNED_ASSETS["circle-usdc"];

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

const planOf = (...ids: ScenarioId[]) =>
  resolvePlan({ scenarios: ids.map((id) => ({ id, params: {} })) });

interface Run {
  signed: { stepId: MessStepId; tx: Transaction }[];
  calls: { stepId: MessStepId; call: ContractCall }[];
  quotes: { asset: Asset; amount: string }[];
}

/** Runs every step of a plan but the setup through the real executors, capturing what is sent. */
async function runPlan(plan: ReturnType<typeof planOf>, quote: BuyQuote): Promise<Run> {
  const run: Run = { signed: [], calls: [], quotes: [] };
  for (const step of plan.steps.filter((s) => s.id !== "SETUP")) {
    const deps: BuildSignSubmitDeps = {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      submit: async (xdr) => {
        const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
        if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
        run.signed.push({ stepId: step.id, tx });
        return { txHash: "hash" };
      },
      sleep: async () => {},
      quoteBuy: async (asset, amount) => {
        run.quotes.push({ asset, amount });
        return quote;
      },
      contractCall: async (_source, call) => {
        run.calls.push({ stepId: step.id, call });
        return { txHash: "soroban-hash" };
      },
      now: () => 1_800_000_000_000,
    };
    await executeMessStep(step, ctx(), deps);
  }
  return run;
}

describe("the pinned contracts", () => {
  test("the pool's tokens are Circle's USDC and XLM, in the pool's order", () => {
    expect([...AQUARIUS.tokens]).toEqual([CIRCLE.contract, XLM_SAC]);
    expect(Buffer.from(AQUARIUS.poolIndex, "hex")).toHaveLength(32);
  });

  test("the verifier's Aquarius row is the pool the seeding deposits in", () => {
    expect(PINNED_SOROBAN_PROTOCOLS.aquarius.entry).toEqual([AQUARIUS.pool]);
    expect(PINNED_SOROBAN_PROTOCOLS.aquarius.family).toEqual([AQUARIUS.shareToken]);
  });
});

describe("the deposit", () => {
  test("is one router call, in the pool's token order, with the demo as the depositor", async () => {
    const plan = planOf("aquarius-lp");
    const run = await runPlan(plan, { sourceAmount: "2.6", path: [] });
    const deposits = run.calls.filter((c) => c.stepId === "AQUARIUS_DEPOSIT");
    expect(deposits).toHaveLength(1);
    const { call } = deposits[0]!;
    expect(call.contract).toBe(AQUARIUS.router);
    expect(call.function).toBe("deposit");
    expect(call.args.map((a) => a.type)).toEqual([
      "scvAddress",
      "scvVec",
      "scvBytes",
      "scvVec",
      "scvU128",
    ]);
    expect(call.args.map((a) => scValToNative(a) as unknown)).toEqual([
      demo.publicKey(),
      [CIRCLE.contract, XLM_SAC],
      Buffer.from(AQUARIUS.poolIndex, "hex"),
      [BigInt(20_000_000), BigInt(50_000_000)],
      BigInt(1),
    ]);
    // Each desired amount is a u128, as the router takes them.
    const amounts = call.args[3]!;
    if (amounts.type !== "scvVec") throw new Error("not a list");
    expect((amounts.vec ?? []).map((a) => a.type)).toEqual(["scvU128", "scvU128"]);
  });

  test("signs no classic transaction of its own", async () => {
    const run = await runPlan(planOf("aquarius-lp"), { sourceAmount: "2.6", path: [] });
    expect(run.signed.map((s) => s.stepId)).toEqual(["TRUST_CIRCLE_USDC", "BUY_CIRCLE_USDC"]);
  });
});

describe("the shared USDC purchase", () => {
  const ids = (plan: ReturnType<typeof planOf>) => plan.steps.map((s) => s.id);

  test("is the resolver's, never a scenario's own step", () => {
    const shared = purchaseBuild(planOf("aquarius-lp").steps);
    expect(shared?.steps.map((o) => o.step.id)).toEqual(["TRUST_CIRCLE_USDC", "BUY_CIRCLE_USDC"]);
    expect(PURCHASE_OWNER).toBe("pinned-purchase");
  });

  test("either pool alone buys what it pairs, within its own ceiling", () => {
    for (const [id, seed] of [
      ["aquarius-lp", AQUARIUS_SEED],
      ["soroswap-lp", SOROSWAP_SEED],
    ] as const) {
      const buy = planOf(id).steps.find((s) => s.id === "BUY_CIRCLE_USDC")!.action;
      expect(buy).toEqual({
        kind: "pinned_buy",
        asset: "circle-usdc",
        amount: seed.usdc,
        maxXlm: seed.buyMaxXlm,
      });
    }
  });

  test("both pools open the trustline and buy once, for both deposits together", async () => {
    const plan = planOf("soroswap-lp", "aquarius-lp");
    expect(ids(plan)).toEqual([
      "SETUP",
      "TRUST_CIRCLE_USDC",
      "BUY_CIRCLE_USDC",
      "SOROSWAP_DEPOSIT",
      "AQUARIUS_DEPOSIT",
    ]);
    const total = String(Number(SOROSWAP_SEED.usdc) + Number(AQUARIUS_SEED.usdc));
    const ceiling = String(Number(SOROSWAP_SEED.buyMaxXlm) + Number(AQUARIUS_SEED.buyMaxXlm));
    for (const id of ["TRUST_CIRCLE_USDC", "BUY_CIRCLE_USDC"] as const) {
      const { action } = plan.steps.find((s) => s.id === id)!;
      expect(action).toMatchObject({ asset: "circle-usdc", amount: total, maxXlm: ceiling });
    }

    const run = await runPlan(plan, { sourceAmount: "5.2", path: [] });
    // One trustline and one purchase, signed once each, and each checked against the DEX for the
    // combined amount before it was signed.
    expect(run.signed.map((s) => s.stepId)).toEqual(["TRUST_CIRCLE_USDC", "BUY_CIRCLE_USDC"]);
    const trusts = run.signed
      .flatMap(({ tx }) => tx.operations)
      .filter((op) => op.type === "changeTrust");
    expect(trusts).toHaveLength(1);
    const buys = run.signed
      .flatMap(({ tx }) => tx.operations)
      .filter((op) => op.type === "pathPaymentStrictReceive");
    expect(buys).toHaveLength(1);
    const buy = buys[0]!;
    if (buy.type !== "pathPaymentStrictReceive") throw new Error("not a purchase");
    expect(buy.destAmount).toBe(`${total}.0000000`);
    expect(buy.sendMax).toBe(`${ceiling}.0000000`);
    expect(run.quotes.map((q) => [q.asset.getCode(), q.asset.getIssuer(), q.amount])).toEqual([
      [CIRCLE.code, CIRCLE.issuer, total],
      [CIRCLE.code, CIRCLE.issuer, total],
    ]);
    // Then each pool's deposit spends its own share of it.
    expect(run.calls.map((c) => c.stepId)).toEqual(["SOROSWAP_DEPOSIT", "AQUARIUS_DEPOSIT"]);
  });

  test("the trustline's balance in the scene follows each deposit", () => {
    const balances = planOf("soroswap-lp", "aquarius-lp").steps.flatMap((s) =>
      s.balances.filter((b) => b.nodeId === "tl:circle-usdc").map((b) => [s.id, b.balance])
    );
    expect(balances).toEqual([
      ["BUY_CIRCLE_USDC", "4"],
      ["SOROSWAP_DEPOSIT", "2"],
      ["AQUARIUS_DEPOSIT", "0"],
    ]);
  });

  test("its cost is counted once: one reserve, one trustline and one purchase for both pools", () => {
    const soroswap = planOf("soroswap-lp").cost;
    const aquarius = planOf("aquarius-lp").cost;
    const both = planOf("soroswap-lp", "aquarius-lp").cost;
    // Summing the two plans counts twice what every plan pays (the demo's two base reserves and
    // the setup) and what the shared purchase pays (the trustline's reserve, its two
    // transactions); the purchase's ceilings add up, as the purchase buys for both.
    expect(both.xlm).toBe(soroswap.xlm + aquarius.xlm - 2 * BASE_RESERVE_XLM - BASE_RESERVE_XLM);
    expect(both.classicTransactions).toBe(
      soroswap.classicTransactions + aquarius.classicTransactions - 1 - 2
    );
    expect(both.sorobanTransactions).toBe(2);
    expect(both.subEntries).toBe(1);
  });
});
