import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import * as readAccount from "@/lib/close-api/read-account";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { mapDomainError, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { ROUTE_LOOKUP_UNAVAILABLE_CODE } from "@/lib/close-api/decisions";
import { AssetRouteLostError } from "@/lib/utils/errors";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { ledgerEntries } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { EMPTY_MARKET, MAINNET_DUST_SHX, MAINNET_LIQUID_USDC } from "./fixtures/horizon-paths";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;
const original = PATH_ROUTING_API_URLS.testnet;
const realFetch = globalThis.fetch;

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  PATH_ROUTING_API_URLS.testnet = "https://paths.example";
});
afterEach(() => {
  mock.restore();
  PATH_ROUTING_API_URLS.testnet = original;
  globalThis.fetch = realFetch;
});

function state(balance: string): AccountState {
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
        asset: ASSET,
        balance,
        limit: "1000",
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
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

function answerWith(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function stubChain(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: ledgerEntries(() => ({ balance: 10000000000n })),
  })) as unknown as typeof rpcModule.getRpcServer);
}

type Outcome = "route" | "no_market" | "dust" | "unknown";

const TABLE: Array<[Outcome, number, unknown, string]> = [
  ["route", 200, MAINNET_LIQUID_USDC, "10.0000000"],
  ["no_market", 200, EMPTY_MARKET, "10.0000000"],
  ["dust", 200, MAINNET_DUST_SHX, "0.0000001"],
  ["unknown", 200, {}, "10.0000000"],
  ["unknown", 400, { status: 400 }, "10.0000000"],
];

test.each(TABLE)(
  "%s (HTTP %d): the plan and the build agree",
  async (outcome, status, body, balance) => {
    answerWith(status, body);
    spyOn(readAccount, "readAccountState").mockResolvedValue(state(balance));
    stubChain();

    const plan = await buildAccountPlan(SOURCE, null, [], "testnet");
    const card = plan.decisionPoints.find((d) => d.type === "asset_disposition");
    const blockerCodes = plan.blockers.map((b) => b.code);
    const build = await buildCloseTransactions(
      state(balance),
      DEST,
      { [ASSET]: "convert" },
      "testnet"
    ).catch((e: unknown) => e);

    if (outcome === "route") {
      expect(card?.options.some((o) => o.id === "convert_to_xlm")).toBe(true);
      expect(blockerCodes).not.toContain(ROUTE_LOOKUP_UNAVAILABLE_CODE);
      expect(build).not.toBeInstanceOf(Error);
      return;
    }

    expect(card?.default === "return_to_issuer").toBe(false);
    if (outcome === "unknown") {
      expect(card).toBeUndefined();
      expect(plan.status).toBe("blocked");
      expect(blockerCodes).toContain(ROUTE_LOOKUP_UNAVAILABLE_CODE);
      expect(build).toBeInstanceOf(Error);
      expect(build).not.toBeInstanceOf(AssetRouteLostError);
      expect(mapDomainError(TRANSACTION_ERRORS, build)).toMatchObject({
        code: "service_unavailable",
        status: 503,
      });
      return;
    }

    expect(card?.options.some((o) => o.id === "convert_to_xlm")).toBe(false);
    expect(card?.default).toBe("");
    expect((card?.subject as { reason?: string }).reason).toBe(
      outcome === "dust" ? "dust_below_minimum" : undefined
    );
    expect(blockerCodes).not.toContain(ROUTE_LOOKUP_UNAVAILABLE_CODE);
    expect(build).toBeInstanceOf(AssetRouteLostError);
  }
);
