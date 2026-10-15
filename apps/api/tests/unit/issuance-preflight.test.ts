import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as readAccount from "@/lib/close-api/read-account";
import * as rpcModule from "@/lib/stellar/rpc";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as issuancePreflight from "@/lib/close-api/issuance-preflight";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import {
  deriveIssuerSupplyDecisionPoints,
  ISSUER_SUPPLY_ACK_CHOICE,
  issuerSupplyDecisionId,
  isIssuerSupplyAcknowledged,
} from "@/lib/close-api/decisions";
import { mapDomainError, PLAN_ERRORS, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { assessIssuanceBlockers } from "@/lib/close-api/issuance-blocker";
import {
  assessIssuance,
  IssuerReadError,
  type IssuanceDeps,
} from "@/lib/close-api/issuance-preflight";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { authorizationOf } from "./fixtures/trustline";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

afterEach(() => {
  mock.restore();
});

function state(): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      {
        asset: `USDC:${ISSUER}`,
        balance: "100.0000000",
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
        limit: "1000",
      },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

// ─── the read ───────────────────────────────────────────────────────────────────────────────

const ZERO_HOLDERS = { authorized: 0, authorized_to_maintain_liabilities: 0, unauthorized: 0 };
const ZERO_BALANCES = {
  authorized: "0.0000000",
  authorized_to_maintain_liabilities: "0.0000000",
  unauthorized: "0.0000000",
};
const ASSET_RECORD = {
  num_claimable_balances: 0,
  num_liquidity_pools: 0,
  num_contracts: 0,
  accounts: { authorized: 3, authorized_to_maintain_liabilities: 0, unauthorized: 1 },
  balances: { ...ZERO_BALANCES, authorized: "10.0000000" },
  claimable_balances_amount: "0.0000000",
  liquidity_pools_amount: "0.0000000",
  contracts_amount: "0.0000000",
};
const DRAINED_RECORD = { ...ASSET_RECORD, accounts: ZERO_HOLDERS, balances: ZERO_BALANCES };

function horizon(answer: { status: number; body?: unknown } | Error): {
  deps: IssuanceDeps;
  requests: string[];
} {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requests.push(`${url.pathname}${url.search}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    requests,
    deps: {
      horizon: () => ({
        baseUrl: "https://horizon.example",
        fetch,
        client: { sleep: async () => {}, policy: { maxRetries: 1 } },
      }),
    },
  };
}

const records = (...rows: unknown[]) => ({ status: 200, body: { _embedded: { records: rows } } });

describe("assessIssuance", () => {
  test("an account issuing assets with units outstanding reports the counts", async () => {
    const h = horizon(
      records(ASSET_RECORD, { ...ASSET_RECORD, num_claimable_balances: 2 }, DRAINED_RECORD)
    );
    expect(await assessIssuance(SOURCE, "testnet", h.deps)).toEqual({
      assetCount: 2,
      holderCount: 4 + 6,
    });
  });

  test("an asset held only by a claimable balance still counts as outstanding", async () => {
    const h = horizon(
      records({
        ...DRAINED_RECORD,
        num_claimable_balances: 1,
        claimable_balances_amount: "0.0000001",
      })
    );
    expect(await assessIssuance(SOURCE, "testnet", h.deps)).toEqual({
      assetCount: 1,
      holderCount: 1,
    });
  });

  test("an account issuing nothing, or only fully redeemed assets, reports none", async () => {
    expect(await assessIssuance(SOURCE, "testnet", horizon(records()).deps)).toBeNull();
    expect(
      await assessIssuance(SOURCE, "testnet", horizon(records(DRAINED_RECORD)).deps)
    ).toBeNull();
  });

  test("it is one request for the closing account's own assets, bounded to a page", async () => {
    const h = horizon(records());
    await assessIssuance(SOURCE, "testnet", h.deps);
    expect(h.requests).toEqual([`/assets?asset_issuer=${SOURCE}&limit=200`]);
  });

  test("a failed or unusable read is a retryable error, never 'issues nothing'", async () => {
    const failures: Array<{ status: number; body?: unknown } | Error> = [
      { status: 404 },
      { status: 403 },
      { status: 429 },
      { status: 500 },
      new Error("socket closed"),
      records({ accounts: "many" }),
    ];
    for (const failure of failures) {
      const err = await assessIssuance(SOURCE, "testnet", horizon(failure).deps).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(IssuerReadError);
      expect(mapDomainError(PLAN_ERRORS, err)).toMatchObject({
        code: "issuer_read_failed",
        status: 503,
      });
      expect(mapDomainError(TRANSACTION_ERRORS, err)?.status).toBe(503);
    }
  });
});

// ─── what it means ──────────────────────────────────────────────────────────────────────────

const ISSUING = { assetCount: 2, holderCount: 7 };

describe("assessIssuanceBlockers", () => {
  test("outstanding supply blocks with the counts until acknowledged", () => {
    const [blocker] = assessIssuanceBlockers(ISSUING, false);
    expect(blocker!.code).toBe("issuer_supply_not_acknowledged");
    expect(blocker!.message).toContain("2 assets");
    expect(blocker!.message).toContain("7 trustlines");
    expect(assessIssuanceBlockers(ISSUING, true)).toEqual([]);
  });

  test("one asset and one holding are worded in the singular", () => {
    const [blocker] = assessIssuanceBlockers({ assetCount: 1, holderCount: 1 }, false);
    expect(blocker!.message).toContain("1 asset that is still held in 1 trustline");
  });

  test("an account issuing nothing never blocks", () => {
    expect(assessIssuanceBlockers(null, false)).toEqual([]);
  });
});

describe("the acknowledgement decision", () => {
  test("it exists only when there is supply, and is scoped to the closing account", () => {
    expect(deriveIssuerSupplyDecisionPoints(SOURCE, null)).toEqual([]);
    const [point] = deriveIssuerSupplyDecisionPoints(SOURCE, ISSUING);
    expect(point).toMatchObject({
      id: issuerSupplyDecisionId(SOURCE),
      type: "confirmation",
      subject: { kind: "issuer_supply", assetCount: 2, holderCount: 7 },
      required: true,
      default: "",
    });
    const answer = { id: issuerSupplyDecisionId(SOURCE), choice: ISSUER_SUPPLY_ACK_CHOICE };
    expect(isIssuerSupplyAcknowledged([answer], SOURCE)).toBe(true);
    expect(isIssuerSupplyAcknowledged([answer], DEST)).toBe(false);
    expect(isIssuerSupplyAcknowledged([{ ...answer, choice: "yes" }], SOURCE)).toBe(false);
  });
});

// ─── plan and build refuse the same state ───────────────────────────────────────────────────

function arrangePlan(): void {
  spyOn(readAccount, "readAccountState").mockResolvedValue(state());
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue({
    kind: "route",
    path: {
      fromAsset: `USDC:${ISSUER}`,
      toAsset: "native",
      path: [],
      estimatedReceive: "1",
      destMin: "1",
    },
  });
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getLatestLedger: () => Promise.resolve({ sequence: 1_000_000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
    address: DEST,
    trustlines: [],
    memoRequired: false,
  });
}

function arrangeBuild(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: async () => ({ sequenceNumber: () => "100" }),
    getLatestLedger: async () => ({ sequence: 1_000_000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
}

const PARITY: Array<[string, typeof ISSUING | null, boolean, string | null]> = [
  ["issues assets, not acknowledged", ISSUING, false, "issuer_supply_not_acknowledged"],
  ["issues assets, acknowledged", ISSUING, true, null],
  ["issues nothing", null, false, null],
];

describe("plan and build refuse the same issuance state", () => {
  test.each(PARITY)("%s", async (_name, issuance, acknowledged, expected) => {
    const answers = acknowledged
      ? [{ id: issuerSupplyDecisionId(SOURCE), choice: ISSUER_SUPPLY_ACK_CHOICE }]
      : [];

    arrangePlan();
    stubIssuance(issuance);
    const plan = await buildAccountPlan(SOURCE, DEST, answers, "testnet");
    const planCodes = plan.blockers.map((b) => b.code).filter((c) => c.startsWith("issuer_"));
    expect(planCodes).toEqual(expected ? [expected] : []);

    mock.restore();
    arrangeBuild();
    stubIssuance(issuance);
    const err = await buildCloseTransactions(
      state(),
      DEST,
      {},
      "testnet",
      null,
      {},
      {},
      {},
      {},
      {},
      false,
      { acknowledged }
    ).catch((e: unknown) => e);
    if (expected) {
      expect(err).toBeInstanceOf(CloseBuildError);
      expect((err as CloseBuildError).code).toBe(expected as CloseBuildError["code"]);
      expect((err as CloseBuildError).status).toBe(422);
    } else {
      expect(err instanceof CloseBuildError && err.code.startsWith("issuer_")).toBe(false);
    }
  });

  test("the plan carries the acknowledgement decision and stays blocked until it is answered", async () => {
    arrangePlan();
    stubIssuance(ISSUING);
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet");
    expect(plan.status).toBe("blocked");
    const point = plan.decisionPoints.find((d) => d.id === issuerSupplyDecisionId(SOURCE));
    expect(point?.subject).toMatchObject({ assetCount: 2, holderCount: 7 });
  });

  test("a failed supply read stops the plan and the build with a retryable error", async () => {
    arrangePlan();
    spyOn(issuancePreflight, "assessIssuance").mockRejectedValue(new IssuerReadError());
    const planErr = await buildAccountPlan(SOURCE, DEST, [], "testnet").catch((e: unknown) => e);
    expect(mapDomainError(PLAN_ERRORS, planErr)?.code).toBe("issuer_read_failed");

    mock.restore();
    arrangeBuild();
    spyOn(issuancePreflight, "assessIssuance").mockRejectedValue(new IssuerReadError());
    const buildErr = await buildCloseTransactions(state(), DEST, {}, "testnet").catch(
      (e: unknown) => e
    );
    expect(mapDomainError(TRANSACTION_ERRORS, buildErr)).toMatchObject({
      code: "issuer_read_failed",
      status: 503,
    });
  });

  test("the supply read starts together with the other live reads", async () => {
    const started: string[] = [];
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getAccount: async () => {
        started.push("account");
        return { sequenceNumber: () => "100" };
      },
      getLatestLedger: async () => {
        started.push("ledger");
        return { sequence: 1_000_000 };
      },
    })) as unknown as typeof rpcModule.getRpcServer);
    spyOn(issuancePreflight, "assessIssuance").mockImplementation(async () => {
      started.push("supply");
      return null;
    });
    await buildCloseTransactions(state(), DEST, {}, "testnet").catch(() => null);
    expect(started.slice(0, 3).sort()).toEqual(["account", "ledger", "supply"]);
  });
});
