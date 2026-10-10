import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair } from "@stellar/stellar-sdk";
import { HttpException } from "@nestjs/common";
import type { AccountState } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as readAccount from "@/lib/close-api/read-account";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { mapDomainError, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { PRICE_SOURCE_UNAVAILABLE } from "@/lib/close-api/decisions";
import { AccountController } from "@/account/account.controller";
import { AssetRouteLostError } from "@/lib/utils/errors";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

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
        authorized: true,
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

const outage = new UpstreamError("unavailable", "paths");

function unavailable(): void {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue({
    kind: "unavailable",
    error: outage,
  });
}

test("plan: an unavailable price source is a price-source blocker, not an illiquid asset", async () => {
  spyOn(readAccount, "readAccountState").mockResolvedValue(state());
  unavailable();

  const plan = await buildAccountPlan(SOURCE, null, [], "testnet");

  expect(plan.status).toBe("blocked");
  expect(plan.blockers.map((b) => b.message)).toContain(PRICE_SOURCE_UNAVAILABLE);
  expect(PRICE_SOURCE_UNAVAILABLE).not.toMatch(/no (conversion )?route|illiquid/i);
  const assetCards = plan.decisionPoints.filter((d) => d.type === "asset_disposition");
  expect(assetCards).toEqual([]);
  expect(JSON.stringify(plan)).not.toContain("No conversion route exists");
  expect(plan.decisionPoints.some((d) => d.default === "return_to_issuer")).toBe(false);
});

test("plan: a genuine empty market still offers return to issuer, with no outage blocker", async () => {
  spyOn(readAccount, "readAccountState").mockResolvedValue(state());
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue({ kind: "none" });

  const plan = await buildAccountPlan(SOURCE, null, [], "testnet");

  expect(plan.blockers.map((b) => b.message)).not.toContain(PRICE_SOURCE_UNAVAILABLE);
  const card = plan.decisionPoints.find((d) => d.type === "asset_disposition");
  expect(card?.default).toBe("return_to_issuer");
});

test("transactions: an unavailable price source is a 503, never a quote_drifted 409", async () => {
  unavailable();
  let snapshot = state().trustlines;
  spyOn(rpcModule, "getRpcServer").mockReturnValue({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot),
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>);

  const failure = await buildCloseTransactions(state(), DEST, {}, "testnet").catch(
    (e: unknown) => e
  );

  expect(failure).toBe(outage);
  expect(failure).not.toBeInstanceOf(AssetRouteLostError);
  expect(mapDomainError(TRANSACTION_ERRORS, failure)).toMatchObject({
    code: "service_unavailable",
    status: 503,
  });
  snapshot = [];
});

test("paths endpoint: an unavailable price source is a 503 service_unavailable, not null", async () => {
  unavailable();
  const failure = await new AccountController()
    .paths("testnet", USDC, "10")
    .catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(HttpException);
  expect((failure as HttpException).getStatus()).toBe(503);
  expect((failure as HttpException).getResponse()).toMatchObject({
    error: { code: "service_unavailable" },
  });
});

test("paths endpoint: a genuine none is still a 200 with a null path", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue({ kind: "none" });
  expect(await new AccountController().paths("testnet", USDC, "10")).toEqual({ path: null });
});
