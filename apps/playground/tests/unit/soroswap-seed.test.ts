import { describe, expect, test } from "bun:test";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  scValToNative,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  buyRoute,
  executeMessStep,
  LiquidityUnavailableError,
  soroswapDepositCall,
  type BuildSignSubmitDeps,
  type BuyQuote,
  type MessContext,
} from "@/lib/mess-builders";
import type { ContractCall } from "@/lib/soroban-seed";
import { runMessStep } from "@/lib/session-actions";
import {
  PINNED_ASSETS,
  resolvePlan,
  SOROSWAP,
  SOROSWAP_SEED,
  XLM_SAC,
  type MessStepDef,
  type MessStepId,
} from "@/lib/scenarios";
import { PINNED_SOROBAN_PROTOCOLS } from "@/lib/verify-soroban";
import { memoryStore, newSessionData } from "./session-fixtures";

// The Soroswap scenario's seeding, with the network replaced: the DEX quote that must show a route
// before any key signs for the scenario, the purchase held to its ceiling, and the one router call
// that builds the position.

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
});

const plan = resolvePlan({ scenarios: [{ id: "soroswap-lp", params: {} }] });
const step = (id: MessStepId): MessStepDef => plan.steps.find((s) => s.id === id)!;

interface Run {
  signed: Transaction[];
  calls: ContractCall[];
  deps: BuildSignSubmitDeps;
}

function harness(quote: BuyQuote | null): Run {
  const run: Run = { signed: [], calls: [], deps: {} };
  run.deps = {
    loadAccount: async () => ({ sequenceNumber: () => "100" }),
    submit: async (xdr) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      run.signed.push(tx);
      return { txHash: "hash" };
    },
    sleep: async () => {},
    quoteBuy: async () => quote,
    contractCall: async (_source, call) => {
      run.calls.push(call);
      return { txHash: "soroban-hash" };
    },
    now: () => 1_800_000_000_000,
  };
  return run;
}

describe("the pinned contracts", () => {
  test("each asset contract is the one its asset derives, and the pair holds both", () => {
    expect(Asset.native().contractId(Networks.TESTNET)).toBe(XLM_SAC);
    expect(new Asset(CIRCLE.code, CIRCLE.issuer).contractId(Networks.TESTNET)).toBe(
      CIRCLE.contract
    );
    expect([...SOROSWAP.tokens]).toEqual([CIRCLE.contract, XLM_SAC]);
  });

  test("the verifier's Soroswap row is the one the seeding uses", () => {
    expect(PINNED_SOROBAN_PROTOCOLS.soroswap.entry).toEqual([SOROSWAP.router]);
    expect(PINNED_SOROBAN_PROTOCOLS.soroswap.family).toEqual([SOROSWAP.pair]);
  });
});

describe("the DEX route comes before any signature", () => {
  test("no route, or one above the ceiling, is refused", async () => {
    await expect(buyRoute("circle-usdc", "2", "4", { quoteBuy: async () => null })).rejects.toThrow(
      LiquidityUnavailableError
    );
    const dear = { quoteBuy: async () => ({ sourceAmount: "4.0000001", path: [] }) };
    await expect(buyRoute("circle-usdc", "2", "4", dear)).rejects.toThrow(
      LiquidityUnavailableError
    );
    const exact = { quoteBuy: async () => ({ sourceAmount: "4", path: [] }) };
    expect((await buyRoute("circle-usdc", "2", "4", exact)).sourceAmount).toBe("4");
  });

  test("the quote asked for is the purchase the scenario makes, of Circle's USDC", async () => {
    const asked: [Asset, string][] = [];
    await buyRoute("circle-usdc", SOROSWAP_SEED.usdc, SOROSWAP_SEED.buyMaxXlm, {
      quoteBuy: async (asset, amount) => {
        asked.push([asset, amount]);
        return { sourceAmount: "2.6", path: [] };
      },
    });
    expect(asked.map(([a, n]) => [a.getCode(), a.getIssuer(), n])).toEqual([
      [CIRCLE.code, CIRCLE.issuer, SOROSWAP_SEED.usdc],
    ]);
  });

  for (const id of ["TRUST_CIRCLE_USDC", "BUY_CIRCLE_USDC"] as const) {
    test(`${id} signs nothing when the DEX has no route`, async () => {
      const run = harness(null);
      await expect(executeMessStep(step(id), ctx(), run.deps)).rejects.toThrow(
        LiquidityUnavailableError
      );
      expect(run.signed).toEqual([]);
    });
  }

  test("a refused step is reported in plain language and stays undone", async () => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      selection: { scenarios: [{ id: "soroswap-lp", params: {} }] },
      completedMessSteps: ["SETUP"],
    });
    const result = await runMessStep(store, session.id, "TRUST_CIRCLE_USDC", {
      executeStep: async () => {
        throw new LiquidityUnavailableError("circle-usdc");
      },
    });
    expect(result).toEqual({ status: 503, body: { error: "testnet_liquidity_unavailable" } });
    expect((await store.loadSession(session.id))?.completedMessSteps).toEqual(["SETUP"]);
  });
});

describe("the seeding transactions", () => {
  test("the trustline is to Circle's USDC, from the demo", async () => {
    const run = harness({ sourceAmount: "2.6", path: [] });
    await executeMessStep(step("TRUST_CIRCLE_USDC"), ctx(), run.deps);
    const [tx] = run.signed;
    expect(tx!.source).toBe(demo.publicKey());
    const op = tx!.operations[0]!;
    if (op.type !== "changeTrust" || !(op.line instanceof Asset)) throw new Error("not a trust");
    expect([op.line.getCode(), op.line.getIssuer()]).toEqual([CIRCLE.code, CIRCLE.issuer]);
  });

  test("the purchase spends at most the ceiling, along the quoted path, into the demo", async () => {
    const via = new Asset("EURC", Keypair.random().publicKey());
    const run = harness({ sourceAmount: "2.6", path: [via] });
    await executeMessStep(step("BUY_CIRCLE_USDC"), ctx(), run.deps);
    const op = run.signed[0]!.operations[0]!;
    if (op.type !== "pathPaymentStrictReceive") throw new Error("not a purchase");
    expect(op.sendAsset.isNative()).toBe(true);
    // The ceiling, not the quote.
    expect(op.sendMax).toBe("4.0000000");
    expect(op.destination).toBe(demo.publicKey());
    expect(op.destAsset.getCode()).toBe(CIRCLE.code);
    expect(op.destAsset.getIssuer()).toBe(CIRCLE.issuer);
    expect(op.destAmount).toBe("2.0000000");
    expect(op.path.map((a) => a.getCode())).toEqual(["EURC"]);
  });

  test("the deposit is one router call that pays the LP share to the demo", async () => {
    const run = harness({ sourceAmount: "2.6", path: [] });
    expect(await executeMessStep(step("SOROSWAP_DEPOSIT"), ctx(), run.deps)).toBe("soroban-hash");
    expect(run.signed).toEqual([]);
    const [call] = run.calls;
    expect(call!.contract).toBe(SOROSWAP.router);
    expect(call!.function).toBe("add_liquidity");
    const args = call!.args.map((a) => scValToNative(a) as unknown);
    expect(args).toEqual([
      CIRCLE.contract,
      XLM_SAC,
      BigInt(20_000_000),
      BigInt(50_000_000),
      BigInt(1),
      BigInt(1),
      demo.publicKey(),
      BigInt(1_800_000_300),
    ]);
    expect(call!.args.map((a) => a.type)).toEqual([
      "scvAddress",
      "scvAddress",
      "scvI128",
      "scvI128",
      "scvI128",
      "scvI128",
      "scvAddress",
      "scvU64",
    ]);
  });

  test("the deposit's tokens are the pair's own, in its order", () => {
    const call = soroswapDepositCall(demo.publicKey(), "2", "5", 0);
    const tokens = call.args.slice(0, 2).map((a) => Address.fromScVal(a).toString());
    expect(tokens).toEqual([...SOROSWAP.tokens]);
  });
});
