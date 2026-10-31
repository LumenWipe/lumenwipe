/**
 * Adversarial coverage (issue #442): a failed or empty route lookup must never become a burn.
 * Returning an asset to its issuer is destructive and happens only on an explicit answer.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import type { PathResult } from "@/lib/stellar/path-finding";
import * as readAccount from "@/lib/close-api/read-account";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { resolveDispositions } from "@/lib/close-api/decisions";
import { AssetRouteLostError } from "@/lib/utils/errors";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";
import { authorizationOf } from "../unit/fixtures/trustline";
import { ledgerEntries } from "../unit/fixtures/ledger-trustlines";
import { stubIssuance } from "../unit/fixtures/issuance";
import { stubLedgerConfirmation } from "../unit/fixtures/ledger-confirmation";

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
});
afterEach(() => mock.restore());

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ASSET = `THIN:${ISSUER}`;

const LOOKUPS: Array<[string, PathResult]> = [
  ["an empty market", { kind: "none", reason: "no_market" }],
  ["a balance too small to swap", { kind: "none", reason: "dust_below_minimum" }],
  ["a failed lookup", { kind: "unavailable", error: new UpstreamError("unavailable", "paths") }],
];

function state(openOffers: AccountState["openOffers"] = []): AccountState {
  const trustline: Trustline = {
    asset: ASSET,
    balance: "10.0000000",
    limit: "1000",
    ...authorizationOf(true),
    issuer: ISSUER,
    code: "THIN",
  };
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1 + openOffers.length,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [trustline],
    openOffers,
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

function stubChain(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: ledgerEntries(() => ({ balance: 100000000n })),
  })) as unknown as typeof rpcModule.getRpcServer);
}

type Op = { type: string; destination?: string };

function opsOf(xdr: string): Op[] {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations as Op[];
}

const paymentsTo = (ops: Op[], who: string): Op[] =>
  ops.filter((o) => o.type === "payment" && o.destination === who);

test.each(LOOKUPS)(
  "an asset left with no route is never auto-routed to its issuer (%s)",
  async (_name, lookup) => {
    spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(lookup);
    spyOn(readAccount, "readAccountState").mockResolvedValue(state());
    stubChain();

    const plan = await buildAccountPlan(SOURCE, null, [], "testnet");
    for (const point of plan.decisionPoints) expect(point.default).not.toBe("return_to_issuer");
    expect(plan.status).not.toBe("ready");
    expect(resolveDispositions([], [])).toEqual({});

    const failure = await buildCloseTransactions(state(), DEST, {}, "testnet").catch(
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(Error);
    expect(
      lookup.kind === "unavailable"
        ? failure === lookup.error
        : failure instanceof AssetRouteLostError
    ).toBe(true);
  }
);

test.each(LOOKUPS)(
  "an unfilled sell order is cancelled and its offered asset is left to an explicit disposition, never an automatic issuer return (%s)",
  async (_name, lookup) => {
    const offer = { id: "7", selling: ASSET, buying: "native", amount: "4.0000000", price: "1" };
    spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(lookup);
    spyOn(readAccount, "readAccountState").mockResolvedValue(state([offer]));
    stubChain();

    const plan = await buildAccountPlan(SOURCE, null, [], "testnet");
    const card = plan.decisionPoints.find((d) => d.type === "asset_disposition");
    expect(card?.default).not.toBe("return_to_issuer");
    expect(plan.steps.some((s) => (s as { type: string }).type === "CANCEL_OFFERS")).toBe(true);

    const unanswered = await buildCloseTransactions(state([offer]), DEST, {}, "testnet").catch(
      (e: unknown) => e
    );
    expect(unanswered).toBeInstanceOf(Error);

    const answered = await buildCloseTransactions(
      state([offer]),
      DEST,
      { [ASSET]: "issuer" },
      "testnet"
    );
    const ops = opsOf(answered.transactions[0]!.xdr);
    expect(ops.some((o) => o.type === "manageSellOffer")).toBe(true);
    expect(paymentsTo(ops, ISSUER)).toHaveLength(1);
  }
);
