import { expect, type Page, type Route } from "@playwright/test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  AccountState,
  AllowancesResult,
  CloseTransactionsRequest,
  MediatorCheckResult,
  PlanResponse,
  PlannedStep,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/types";
import type { FeedData, StatsResult } from "../../../lib/stats";
import { emptyDefiPositionsResult } from "../../unit/fixtures/defi-positions";

/**
 * Answers every `/api/**` call the app makes from the browser, so the accessibility gate is
 * deterministic and never reaches testnet. A request no fixture answers fails the test that
 * made it, rather than letting a screen render its error state unnoticed.
 */

const SEQUENCE = "100";

/** An account the analyze page cannot render: `trustlines` is not a list, so reading it throws
 *  during render and the network error boundary takes over. */
export const UNRENDERABLE_ACCOUNT = Keypair.random().publicKey();

/** An account holding one Soroban token whose only quote is flagged for its price impact, so
 *  the analyze page shows the conversion's warning and its confirmation checkbox. */
export const FLAGGED_TOKEN_ACCOUNT = Keypair.random().publicKey();
const FLAGGED_TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";

function flaggedTokenAccount(address: string): AccountState {
  return {
    ...accountState(address),
    sorobanTokens: {
      tokens: [
        {
          contract: FLAGGED_TOKEN,
          balance: "2500000000",
          symbol: "XTAR",
          decimals: 7,
          sources: ["explorer"],
        },
      ],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
  };
}

function flaggedTokenPlan(): PlanResponse {
  return {
    ...plan(),
    status: "needs_decisions",
    decisionPoints: [
      {
        id: `token:${FLAGGED_TOKEN}`,
        type: "asset_disposition",
        subject: {
          kind: "soroban_token",
          contract: FLAGGED_TOKEN,
          symbol: "XTAR",
          decimals: 7,
          balance: "2500000000",
          convertible: true,
          arrivesFromExit: false,
          quote: {
            amountOut: "50000000",
            minAmountOut: "49750000",
            platform: "aggregator",
            provider: "soroswap",
            route: ["soroswap"],
            priceImpactBps: 2450,
            flags: ["high_impact"],
          },
        },
        options: [
          { id: "convert_to_xlm", note: "Converting needs your confirmation." },
          { id: "transfer_to_account" },
          { id: "acknowledge_residue" },
        ],
        default: "transfer_to_account",
        required: true,
      },
    ],
  };
}

/** An account with one asset to swap, one to send to another account and one claimable balance
 *  to leave unclaimed, so the review has one row of each to show. */
export const OUTCOMES_ACCOUNT = Keypair.random().publicKey();
export const OUTCOMES_ISSUER = Keypair.random().publicKey();
const OUTCOMES_BALANCE_ID = `00000000${"ab".repeat(32)}`;

function outcomesTrustline(code: string, balance: string): AccountState["trustlines"][number] {
  return {
    asset: `${code}:${OUTCOMES_ISSUER}`,
    code,
    issuer: OUTCOMES_ISSUER,
    balance,
    authorized: true,
    authorization: "authorized",
    clawbackEnabled: false,
  };
}

function outcomesAccount(address: string): AccountState {
  return {
    ...accountState(address),
    nativeBalanceLumens: "20.0000000",
    numSubEntries: 2,
    trustlines: [outcomesTrustline("USDC", "5.0000000"), outcomesTrustline("EURC", "3.0000000")],
    claimableBalances: [
      {
        id: OUTCOMES_BALANCE_ID,
        asset: `USDC:${OUTCOMES_ISSUER}`,
        amount: "1.5000000",
        claimants: [{ destination: address, predicate: { type: "unconditional" } }],
        sponsor: null,
      },
    ],
  };
}

function outcomesPlan(decided: boolean): PlanResponse {
  const step = (index: number, type: PlannedStep["type"], title: string): PlannedStep => ({
    ...MERGE_STEP,
    index,
    type,
    title,
    description: "",
  });
  const usdc = `USDC:${OUTCOMES_ISSUER}`;
  const eurc = `EURC:${OUTCOMES_ISSUER}`;
  return {
    ...plan(),
    status: decided ? "ready" : "needs_decisions",
    steps: [
      step(0, "HANDLE_ASSETS", "Swap and send assets"),
      step(1, "REMOVE_TRUSTLINES", "Remove trustlines"),
      { ...MERGE_STEP, index: 2 },
    ],
    estimate: { feeStroops: "300", freedReserveXlm: "2" },
    execution: { estimatedTransactionCount: 2, transactions: [] },
    decisionPoints: [
      {
        id: `asset:${usdc.replace(":", "-")}`,
        type: "asset_disposition",
        subject: {
          kind: "trustline",
          asset: usdc,
          balance: "5.0000000",
          convertible: true,
          quote: { estimatedReceive: "25000000", minAmountOut: "24000000" },
          arrivesFromExit: false,
        },
        options: [{ id: "convert_to_xlm" }, { id: "transfer_to_account" }],
        default: "convert_to_xlm",
        required: true,
      },
      {
        id: `asset:${eurc.replace(":", "-")}`,
        type: "asset_disposition",
        subject: {
          kind: "trustline",
          asset: eurc,
          balance: "3.0000000",
          convertible: false,
          arrivesFromExit: false,
        },
        options: [{ id: "return_to_issuer" }, { id: "transfer_to_account" }],
        default: "",
        required: true,
      },
      {
        id: `claim:${OUTCOMES_BALANCE_ID}`,
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: OUTCOMES_BALANCE_ID,
          asset: usdc,
          amount: "1.5000000",
          currentlyClaimable: true,
          predicate: { type: "unconditional" },
        },
        options: [{ id: "claim" }, { id: "forfeit" }],
        default: "claim",
        required: true,
      },
    ],
  };
}

export function accountState(address: string): AccountState {
  return {
    address,
    network: "testnet",
    sequence: SEQUENCE,
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: address, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(address),
    defiPositionsWarnings: [],
  };
}

const MERGE_STEP: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "Merge account",
  description: "Send the remaining XLM to the destination and remove the account.",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

/** A plan hash of the shape the API returns: /review refuses to install any other. */
const FIXTURE_PLAN_HASH = "a1".repeat(32);

function plan(): PlanResponse {
  return {
    planHash: FIXTURE_PLAN_HASH,
    status: "ready",
    steps: [MERGE_STEP],
    decisionPoints: [],
    blockers: [],
    estimate: { feeStroops: "100", freedReserveXlm: "1" },
    execution: { estimatedTransactionCount: 1, transactions: [{ order: 0, covers: ["MERGE"] }] },
  };
}

function mergeRound(request: CloseTransactionsRequest): TransactionsResponse {
  const xdr = new TransactionBuilder(new Account(request.source, SEQUENCE), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: request.destination }))
    .setTimeout(300)
    .build()
    .toXDR();
  return {
    planHash: FIXTURE_PLAN_HASH,
    status: "ready",
    transactions: [
      {
        id: "merge",
        order: 0,
        dependsOn: [],
        xdr,
        networkPassphrase: Networks.TESTNET,
        sourceSequence: String(Number(SEQUENCE) + 1),
        validUntilLedger: 1_000_000,
        covers: ["MERGE"],
        intent: {
          summary: "Merge the account into the destination",
          source: request.source,
          fee: "100",
          memo: null,
          memoType: null,
          guarantees: {
            mergeDestination: request.destination,
            paymentsOnlyTo: [],
            minXlmFromConversions: null,
          },
          operations: [
            { type: "account_merge", destination: request.destination, source: request.source },
          ],
        },
      },
    ],
    remaining: { steps: 0, requiresAnotherCall: false },
    sourceAccount: {
      signers: [{ key: request.source, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 0, high: 0 },
    },
  };
}

const NOT_AN_EXCHANGE: MediatorCheckResult = {
  requiresMediator: false,
  reason: "not a listed exchange",
  requiresMemo: false,
  memoType: null,
  exchangeName: null,
  available: true,
  registryFresh: true,
};

function allowances(): AllowancesResult {
  return {
    allowances: [
      {
        token: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
        tokenSymbol: "XLM",
        tokenDecimals: 7,
        spender: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        spenderProtocol: null,
        amount: "10000000",
        expirationLedger: 2_000_000,
        sources: ["events"],
      },
    ],
    coverage: [
      { source: "events", status: "ok" },
      { source: "registry", status: "ok" },
    ],
    eventsScanned: { fromLedger: 1, toLedger: 2 },
    warnings: [],
  };
}

const STATS: StatsResult = {
  testnet: 12,
  mainnet: 34,
  testnetXlmStroops: "120000000",
  mainnetXlmStroops: "340000000",
};

const FEED: FeedData = {
  recent: [
    {
      txHash: "f".repeat(64),
      network: "mainnet",
      accountsClosed: 1,
      xlmStroops: "15000000",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ],
  daily: [{ date: "2026-01-01", count: 1 }],
  totals: STATS,
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function txHash(signedXdr: string): string {
  return Buffer.from(TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET).hash()).toString(
    "hex"
  );
}

/** Routes every API call to a fixture and returns the list of calls nothing answered. */
export async function installApiFixtures(page: Page): Promise<{ expectAllAnswered(): void }> {
  const unanswered: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    let match: RegExpMatchArray | null;

    if ((match = pathname.match(/^\/api\/testnet\/account\/([^/]+)$/))) {
      const address = decodeURIComponent(match[1]);
      if (address === UNRENDERABLE_ACCOUNT) {
        return json(route, { ...accountState(address), trustlines: "unrenderable" });
      }
      if (address === FLAGGED_TOKEN_ACCOUNT) return json(route, flaggedTokenAccount(address));
      if (address === OUTCOMES_ACCOUNT) return json(route, outcomesAccount(address));
      return json(route, accountState(address));
    }
    if (method === "POST" && pathname === "/api/v1/testnet/close/plan") {
      const { source, decisions } = request.postDataJSON() as {
        source: string;
        decisions?: unknown[];
      };
      if (source === OUTCOMES_ACCOUNT) {
        return json(route, outcomesPlan((decisions?.length ?? 0) > 0));
      }
      return json(route, source === FLAGGED_TOKEN_ACCOUNT ? flaggedTokenPlan() : plan());
    }
    if (method === "POST" && pathname === "/api/v1/testnet/close/transactions") {
      return json(route, mergeRound(request.postDataJSON() as CloseTransactionsRequest));
    }
    if (method === "POST" && pathname === "/api/v1/testnet/submit") {
      const { signedXdr } = request.postDataJSON() as { signedXdr: string };
      return json(route, { hash: txHash(signedXdr), ledger: 1 });
    }
    if ((match = pathname.match(/^\/api\/v1\/testnet\/transactions\/([0-9a-f]{64})$/))) {
      const found: TransactionLookupResponse = { status: "confirmed", hash: match[1], ledger: 1 };
      return json(route, found);
    }
    if (pathname.startsWith("/api/testnet/mediator/check/")) return json(route, NOT_AN_EXCHANGE);
    if (pathname.startsWith("/api/testnet/allowances/")) return json(route, allowances());
    if (pathname === "/api/config/exchange-registry") return json(route, {}, 503);
    if (pathname === "/api/stats") return json(route, STATS);
    if (pathname === "/api/stats/feed") return json(route, FEED);

    unanswered.push(`${method} ${pathname}`);
    return json(route, { error: { code: "UNROUTED", message: "no fixture" } }, 500);
  });

  return {
    expectAllAnswered: () => expect(unanswered, "API calls with no fixture").toEqual([]),
  };
}
