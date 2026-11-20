import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  Account,
  Keypair,
  LiquidityPoolAsset,
  Networks,
  TransactionBuilder,
  type Operation,
} from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import { ALL_ON } from "@/config/kill-switches";
import { buildPlan } from "@/lib/stellar/tx-builder";
import {
  assessPoolShareBlockers,
  planPoolWithdrawal,
  poolProceedsPerAsset,
  poolWithdrawalAmount,
  poolWithdrawalMinimum,
  poolWithdrawalOps,
} from "@/lib/stellar/tx-builder/pool-withdrawal";
import { readLiquidityPools } from "@/lib/stellar/liquidity-pools";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { projectClassicFees } from "@/lib/close-api/sponsored-fees";
import { deriveDecisionPoints, assetDecisionId } from "@/lib/close-api/decisions";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { ledgerRpcServer, mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { poolIdOf, poolShare, poolState, withPools } from "./fixtures/liquidity-pools";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const EURC = `EURC:${ISSUER}`;
const USDC = `USDC:${ISSUER}`;

function line(asset: string, balance = "0.0000000", over: Partial<Trustline> = {}): Trustline {
  const [code, issuer] = asset.split(":") as [string, string];
  return { asset, balance, ...authorizationOf(true), issuer, code, ...over };
}

function makeState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ...over,
  };
}

// An XLM/USDC pool: 1000 XLM and 500 USDC against 700 shares, of which the account holds 70.
const XLM_USDC = poolState("native", USDC, 10_000_000_000n, 5_000_000_000n, 7_000_000_000n);
// A EURC/USDC pool of two issued assets.
const EURC_USDC = poolState(EURC, USDC, 3_000_000_000n, 3_300_000_000n, 1_000_000_000n);

describe("withdrawal amounts", () => {
  test("round down exactly as stellar-core's bigDivide(shares, reserve, total, ROUND_DOWN)", () => {
    expect(poolWithdrawalAmount(1n, 2n, 3n)).toBe(0n);
    expect(poolWithdrawalAmount(2n, 5n, 3n)).toBe(3n);
    expect(poolWithdrawalAmount(700_000_000n, 10_000_000_000n, 7_000_000_000n)).toBe(
      1_000_000_000n
    );
    expect(poolWithdrawalAmount(5n, 7n, 0n)).toBe(0n);
  });

  test("hold each side to 1% under what the reserves give, never to zero while it gives any", () => {
    expect(poolWithdrawalMinimum(0n)).toBe(0n);
    expect(poolWithdrawalMinimum(1n)).toBe(1n);
    expect(poolWithdrawalMinimum(99n)).toBe(98n);
    expect(poolWithdrawalMinimum(100n)).toBe(99n);
    expect(poolWithdrawalMinimum(1_000_000_000n)).toBe(990_000_000n);
  });
});

describe("withdrawal operations", () => {
  test("withdraw every share, then remove the share line built from the pool's parameters", () => {
    const w = planPoolWithdrawal(poolShare(XLM_USDC, "70.0000000"), XLM_USDC);
    const ops = poolWithdrawalOps([w]);
    const tx = TransactionBuilder.fromXDR(
      new TransactionBuilder(new Account(SOURCE, "1"), {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .setTimeout(30)
        .addOperation(ops[0]!)
        .addOperation(ops[1]!)
        .build()
        .toXDR(),
      Networks.TESTNET
    );
    const [withdraw, removal] = tx.operations as [
      Operation.LiquidityPoolWithdraw,
      Operation.ChangeTrust,
    ];
    expect(withdraw.type).toBe("liquidityPoolWithdraw");
    expect(withdraw.liquidityPoolId).toBe(poolIdOf("native", USDC));
    expect(withdraw.amount).toBe("70.0000000");
    expect(withdraw.minAmountA).toBe("99.0000000");
    expect(withdraw.minAmountB).toBe("49.5000000");
    expect(removal.type).toBe("changeTrust");
    expect(removal.limit).toBe("0.0000000");
    expect(removal.line).toBeInstanceOf(LiquidityPoolAsset);
    expect((removal.line as LiquidityPoolAsset).toString()).toBe(
      `liquidity_pool:${poolIdOf("native", USDC)}`
    );
  });

  test("an empty share line is only removed: the ledger refuses a zero withdrawal as malformed", () => {
    const w = planPoolWithdrawal(poolShare(XLM_USDC, "0.0000000"), XLM_USDC);
    const ops = poolWithdrawalOps([w]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.body.type).toBe("changeTrust");
  });
});

describe("proceeds", () => {
  test("count what lands in a trustline, summed per asset across pools", () => {
    const state = makeState({
      poolShares: [poolShare(XLM_USDC, "70.0000000"), poolShare(EURC_USDC, "10.0000000")],
    });
    expect(poolProceedsPerAsset(state)).toEqual(
      new Map([
        [USDC, 500_000_000n + 330_000_000n],
        [EURC, 300_000_000n],
      ])
    );
  });

  test("leave out XLM and an asset the account issues, which the withdrawal retires", () => {
    const own = `OWN:${SOURCE}`;
    const pool = poolState(own, USDC, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n);
    const state = makeState({ poolShares: [poolShare(pool, "10.0000000")] });
    expect(poolProceedsPerAsset(state)).toEqual(new Map([[USDC, 100_000_000n]]));
  });

  test("leave out a pool the read could not see into", () => {
    const state = makeState({
      poolShares: [{ poolId: poolIdOf("native", USDC), balance: "1.0000000", pool: null }],
    });
    expect(poolProceedsPerAsset(state).size).toBe(0);
  });
});

describe("blockers", () => {
  const share = poolShare(EURC_USDC, "10.0000000");

  test("none for a pool whose sides can be paid in", () => {
    const state = makeState({ poolShares: [share], trustlines: [line(EURC), line(USDC)] });
    expect(assessPoolShareBlockers(state)).toEqual([]);
  });

  test("a side the issuer only lets keep its offers is refused before anything is withdrawn", () => {
    const state = makeState({
      poolShares: [share],
      trustlines: [
        line(EURC, "0.0000000", { authorized: false, authorization: "maintain_liabilities" }),
        line(USDC),
      ],
    });
    const [blocker] = assessPoolShareBlockers(state);
    expect(blocker?.code).toBe("liquidity_pool_shares_held");
    expect(blocker?.message).toContain("EURC");
  });

  test("a side whose trustline limit leaves no room is refused", () => {
    const state = makeState({
      poolShares: [share],
      trustlines: [line(EURC, "95.0000000", { limit: "100.0000000" }), line(USDC)],
    });
    expect(assessPoolShareBlockers(state)[0]?.message).toContain("limit");
    const roomy = makeState({
      poolShares: [share],
      trustlines: [line(EURC, "70.0000000", { limit: "100.0000000" }), line(USDC)],
    });
    expect(assessPoolShareBlockers(roomy)).toEqual([]);
  });

  test("an XLM side and an asset the account issues need no trustline", () => {
    const own = `OWN:${SOURCE}`;
    const pool = poolState("native", own, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n);
    const state = makeState({ poolShares: [poolShare(pool, "10.0000000")] });
    expect(assessPoolShareBlockers(state)).toEqual([]);
  });
});

describe("the plan", () => {
  const state = makeState({
    numSubEntries: 5,
    trustlines: [line(EURC), line(USDC, "2.0000000")],
    poolShares: [poolShare(XLM_USDC, "70.0000000"), poolShare(EURC_USDC, "10.0000000")],
  });

  test("raises no blocker for a withdrawable pool and withdraws it ahead of the close", () => {
    const { steps, blockers } = buildPlan(ALL_ON, state, false, true);
    expect(blockers).toEqual([]);
    expect(steps.map((s) => s.type)).toEqual([
      "WITHDRAW_POOL_SHARES",
      "WITHDRAW_POOL_SHARES",
      "HANDLE_ASSETS",
      "HANDLE_ASSETS",
      "REMOVE_TRUSTLINES",
      "MERGE",
    ]);
  });

  test("shows the pool, the shares and the least of each side", () => {
    const { steps } = buildPlan(ALL_ON, state, false);
    expect(steps[0]!.title).toBe("Withdraw from the XLM/USDC pool");
    expect(steps[0]!.description).toContain("all 70.0000000 shares");
    expect(steps[0]!.description).toContain("at least 99.0000000 XLM and at least 49.5000000 USDC");
    expect(steps[0]!.operationCount).toBe(2);
  });

  test("disposes of an empty line the pool fills, at the amount it will hold", () => {
    const { steps } = buildPlan(ALL_ON, state, false, false, {}, undefined, { [EURC]: "issuer" });
    const eurc = steps.find((s) => s.affectedAsset === EURC);
    expect(eurc?.title).toBe("Return EURC to issuer");
    expect(eurc?.description).toContain("30.0000000 EURC");
    const usdc = steps.find((s) => s.affectedAsset === USDC);
    expect(usdc?.description).toContain(`${(2 + 50 + 33).toFixed(7)} USDC`);
  });

  test("says a side the account issues is retired", () => {
    const own = `OWN:${SOURCE}`;
    const pool = poolState("native", own, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n);
    const { steps } = buildPlan(
      ALL_ON,
      makeState({ numSubEntries: 2, poolShares: [poolShare(pool, "10.0000000")] }),
      false
    );
    expect(steps[0]!.description).toContain("returned to you as its issuer, which retires it");
  });

  test("an empty share line is a one-operation step", () => {
    const { steps } = buildPlan(
      ALL_ON,
      makeState({ numSubEntries: 2, poolShares: [poolShare(XLM_USDC, "0.0000000")] }),
      false
    );
    expect(steps[0]!.operationCount).toBe(1);
    expect(steps[0]!.description).toContain("empty share trustline");
  });

  test("asks for a decision about an empty line only the pool fills", () => {
    const points = deriveDecisionPoints(state, { [EURC]: true, [USDC]: true });
    const eurc = points.find((p) => p.id === assetDecisionId(EURC));
    expect(eurc).toBeDefined();
  });
});

describe("the fee projection counts the pool round, which no sponsor pays", () => {
  // One pool share line (two sub-entries) and one asset line: a floor of (2 + 3) * 0.5 XLM.
  const at = (nativeBalanceLumens: string): AccountState =>
    makeState({
      nativeBalanceLumens,
      numSubEntries: 3,
      trustlines: [line(USDC)],
      poolShares: [poolShare(XLM_USDC, "70.0000000")],
    });
  const dispositions = { [USDC]: "convert" };

  test("without a sponsor: the pool round's two operations and the close's three", () => {
    expect(projectClassicFees(at("2.5000500"), dispositions, {}, false, false).shortStroops).toBe(
      0n
    );
    expect(projectClassicFees(at("2.5000499"), dispositions, {}, false, false).shortStroops).toBe(
      1n
    );
  });

  test("with a sponsor: the close is sponsored, the pool round is still the account's", () => {
    expect(projectClassicFees(at("2.5000200"), dispositions, {}, false, true).shortStroops).toBe(
      0n
    );
    expect(projectClassicFees(at("2.5000199"), dispositions, {}, false, true).shortStroops).toBe(
      1n
    );
  });
});

describe("reading pools", () => {
  test("reads every pool in one call and decodes its parameters and reserves", async () => {
    const calls: number[] = [];
    const answer = withPools([XLM_USDC, EURC_USDC], () => Promise.reject(new Error("not a pool")));
    const spy = {
      getLedgerEntries: (...keys: Parameters<typeof answer>) => {
        calls.push(keys.length);
        return answer(...keys);
      },
    };
    const pools = await readLiquidityPools(spy, [poolIdOf("native", USDC), poolIdOf(EURC, USDC)]);
    expect(calls).toEqual([2]);
    expect(pools.get(poolIdOf("native", USDC))).toEqual(XLM_USDC);
    expect(pools.get(poolIdOf(EURC, USDC))).toEqual(EURC_USDC);
  });

  test("a failed read is never taken as no pool", async () => {
    const server = { getLedgerEntries: () => Promise.reject(new Error("down")) };
    expect(readLiquidityPools(server, [poolIdOf("native", USDC)])).rejects.toBeInstanceOf(
      LiveReadError
    );
  });
});

describe("the pool round", () => {
  let snapshot: Trustline[] = [];
  beforeEach(() => {
    stubIssuance();
    stubLedgerConfirmation();
  });
  afterEach(() => mock.restore());

  function serve(pools: Parameters<typeof withPools>[0]): void {
    spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
      ledgerRpcServer(
        SOURCE,
        withPools(
          pools,
          mirrorSnapshot(SOURCE, () => snapshot)
        )
      )
    );
  }

  function opsOf(xdr: string) {
    return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
  }

  test("withdraws at the live reserves, alone, before the close disposes of what arrives", async () => {
    // The pool moved since the account read: the minimums follow the ledger, not the read.
    const live = poolState("native", USDC, 11_000_000_000n, 4_600_000_000n, 7_000_000_000n);
    serve([live]);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({
      numSubEntries: 3,
      trustlines: [line(USDC)],
      poolShares: [poolShare(XLM_USDC, "70.0000000")],
    });
    snapshot = state.trustlines;

    const result = await buildCloseTransactions(
      ALL_ON,
      state,
      DEST,
      { [USDC]: "issuer" },
      "testnet"
    );

    expect(result.requiresAnotherCall).toBe(true);
    expect(result.remainingSteps).toBe(1);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.covers).toEqual(["WITHDRAW_POOL_SHARES"]);
    expect(result.transactions[0]!.needsSponsoredFee).toBeUndefined();
    const ops = opsOf(result.transactions[0]!.xdr);
    expect(ops.map((o) => o.type)).toEqual(["liquidityPoolWithdraw", "changeTrust"]);
    const withdraw = ops[0] as Operation.LiquidityPoolWithdraw;
    expect(withdraw.minAmountA).toBe("108.9000000");
    expect(withdraw.minAmountB).toBe("45.5400000");
  });

  test("the round after it disposes of the arrived balance and removes the asset line", async () => {
    serve([]);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({ numSubEntries: 1, trustlines: [line(USDC, "50.0000000")] });
    snapshot = state.trustlines;

    const result = await buildCloseTransactions(
      ALL_ON,
      state,
      DEST,
      { [USDC]: "issuer" },
      "testnet"
    );

    expect(result.requiresAnotherCall).toBe(false);
    const ops = opsOf(result.transactions[0]!.xdr);
    expect(ops.map((o) => o.type)).toEqual(["payment", "changeTrust", "accountMerge"]);
  });

  test("a pool the ledger does not return is a failed read, not a skipped pool", async () => {
    serve([]);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({
      numSubEntries: 3,
      trustlines: [line(USDC)],
      poolShares: [poolShare(XLM_USDC, "70.0000000")],
    });
    snapshot = state.trustlines;
    expect(
      buildCloseTransactions(ALL_ON, state, DEST, { [USDC]: "issuer" }, "testnet")
    ).rejects.toBeInstanceOf(LiveReadError);
  });

  test("a transfer with no destination for an asset the pool pays in is refused before it lands", async () => {
    serve([XLM_USDC]);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({
      numSubEntries: 3,
      trustlines: [line(USDC)],
      poolShares: [poolShare(XLM_USDC, "70.0000000")],
    });
    snapshot = state.trustlines;
    expect(
      buildCloseTransactions(ALL_ON, state, DEST, { [USDC]: "transfer" }, "testnet")
    ).rejects.toThrow(/requires the account to send it to/);
  });

  test("an account that cannot pay the pool round itself is refused, sponsor or not", async () => {
    serve([XLM_USDC]);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({
      nativeBalanceLumens: "2.5000199",
      numSubEntries: 3,
      trustlines: [line(USDC)],
      poolShares: [poolShare(XLM_USDC, "70.0000000")],
    });
    snapshot = state.trustlines;
    expect(
      buildCloseTransactions(ALL_ON, state, DEST, { [USDC]: "issuer" }, "testnet")
    ).rejects.toMatchObject({ code: "close_fee_balance_short" });
  });

  test("more pools than one round holds carry on in the next call", async () => {
    const pools = Array.from({ length: 51 }, (_, i) =>
      poolState("native", `P${i}:${ISSUER}`, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n)
    );
    serve(pools);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    const state = makeState({
      nativeBalanceLumens: "500.0000000",
      numSubEntries: 51 * 3,
      trustlines: pools.map((p) => line(p.assetB)),
      poolShares: pools.map((p) => poolShare(p, "0.0000000")),
    });
    snapshot = state.trustlines;
    const dispositions = Object.fromEntries(pools.map((p) => [p.assetB, "issuer" as const]));

    const result = await buildCloseTransactions(ALL_ON, state, DEST, dispositions, "testnet");

    expect(result.transactions).toHaveLength(1);
    expect(opsOf(result.transactions[0]!.xdr)).toHaveLength(50);
    expect(result.remainingSteps).toBe(2);
  });
});
