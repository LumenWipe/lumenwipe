import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, DecisionPoint } from "@lumenwipe/types";
import * as readAccount from "@/lib/close-api/read-account";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { ROUTE_LOOKUP_UNAVAILABLE_CODE } from "@/lib/close-api/decisions";
import type { fetchConversionPath } from "@/lib/stellar/path-finding";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
});

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
        asset: USDC,
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

async function assetCard(
  path: typeof fetchConversionPath
): Promise<{ card: DecisionPoint | undefined; blockerCodes: (string | undefined)[] }> {
  spyOn(readAccount, "readAccountState").mockResolvedValue(state());
  const plan = await buildAccountPlan(SOURCE, null, [], "testnet", { fetchConversionPath: path });
  return {
    card: plan.decisionPoints.find((d) => d.type === "asset_disposition"),
    blockerCodes: plan.blockers.map((b) => b.code),
  };
}

test("a route puts its quote, in stroops, on the asset's subject and keeps the options", async () => {
  const { card } = await assetCard(async (fromAsset) => ({
    kind: "route",
    path: {
      fromAsset,
      toAsset: "native",
      path: [],
      estimatedReceive: "42.5000000",
      destMin: "42.2875000",
    },
  }));

  expect(card?.subject.quote).toEqual({ estimatedReceive: "425000000", minAmountOut: "422875000" });
  expect(card?.options.map((o) => o.id)).toEqual([
    "convert_to_xlm",
    "return_to_issuer",
    "transfer_to_account",
  ]);
  expect(card?.default).toBe("convert_to_xlm");
});

test("an empty route carries no quote and offers no conversion", async () => {
  const { card } = await assetCard(async () => ({ kind: "none", reason: "no_market" }));

  expect(card?.subject.quote).toBeUndefined();
  expect(card?.subject.convertible).toBe(false);
  expect(card?.options.map((o) => o.id)).not.toContain("convert_to_xlm");
  expect(card?.default).toBe("");
});

test("a failed lookup carries no quote and no card, only the retryable blocker", async () => {
  const { card, blockerCodes } = await assetCard(async () => ({
    kind: "unavailable",
    error: new UpstreamError("unavailable", "paths"),
  }));

  expect(card).toBeUndefined();
  expect(blockerCodes).toContain(ROUTE_LOOKUP_UNAVAILABLE_CODE);
});
