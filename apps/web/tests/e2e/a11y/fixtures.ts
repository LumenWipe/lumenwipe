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

function plan(): PlanResponse {
  return {
    planHash: "a11y-fixture-plan",
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
    planHash: "a11y-fixture-plan",
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
      return json(route, accountState(address));
    }
    if (method === "POST" && pathname === "/api/v1/testnet/close/plan") return json(route, plan());
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
