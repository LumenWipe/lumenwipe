/**
 * Adversarial coverage (issue #546): an unfilled sell order must never let its asset be lost.
 * An offer escrows nothing; it reserves part of an existing balance as selling liabilities
 * (CAP-3, stellar-protocol core/cap-0003.md), so cancelling releases no value. What must hold
 * is that the whole balance, not just the offered part, gets a disposition or a blocker, and
 * that no merge is ever built past an undisposed balance.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, ConversionPath, Trustline } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import type { PathResult } from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";
import { authorizationOf } from "../unit/fixtures/trustline";
import { ledgerEntries } from "../unit/fixtures/ledger-trustlines";
import { stubIssuance } from "../unit/fixtures/issuance";

beforeEach(() => stubIssuance());
afterEach(() => mock.restore());

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const TRANSFER_TO = Keypair.random().publicKey();
const ASSET = `THIN:${ISSUER}`;
const BALANCE = "10.0000000";
const OFFERED = "4.0000000";

const OFFER = { id: "7", selling: ASSET, buying: "native", amount: OFFERED, price: "1" };
const XLM_OFFER = { id: "8", selling: "native", buying: ASSET, amount: "2.0000000", price: "1" };

const ROUTE: PathResult = {
  kind: "route",
  path: {
    fromAsset: ASSET,
    toAsset: "native",
    path: [],
    estimatedReceive: "10.0000000",
    destMin: "9.9500000",
  } satisfies ConversionPath,
};
const NO_MARKET: PathResult = { kind: "none", reason: "no_market" };

function state(openOffers: AccountState["openOffers"], balance = BALANCE): AccountState {
  const trustline: Trustline = {
    asset: ASSET,
    balance,
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

function stubChain(balance = BALANCE): void {
  const stroops = BigInt(balance.replace(".", ""));
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: ledgerEntries((id) =>
      id.startsWith(`${TRANSFER_TO}|`) ? { balance: 0n } : { balance: stroops }
    ),
  })) as unknown as typeof rpcModule.getRpcServer);
}

type Op = {
  type: string;
  destination?: string;
  amount?: string;
  sendAmount?: string;
  offerId?: string;
  limit?: string;
};

function opsOf(xdr: string): Op[] {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations as Op[];
}

const types = (ops: Op[]): string[] => ops.map((o) => o.type);

async function build(
  offers: AccountState["openOffers"],
  dispositions: Record<string, "convert" | "issuer" | "transfer">,
  balance = BALANCE
): Promise<Op[]> {
  const result = await buildCloseTransactions(
    state(offers, balance),
    DEST,
    dispositions,
    "testnet",
    null,
    {},
    { [ASSET]: TRANSFER_TO }
  );
  return result.transactions.flatMap((t) => opsOf(t.xdr));
}

function expectCancelThenDisposeThenMerge(ops: Op[], disposition: string): void {
  const kinds = types(ops);
  const cancel = kinds.indexOf("manageSellOffer");
  const dispose = kinds.indexOf(disposition);
  const removal = kinds.indexOf("changeTrust");
  expect(cancel).toBeGreaterThanOrEqual(0);
  expect(ops[cancel]!.amount).toBe("0.0000000");
  expect(dispose).toBeGreaterThan(cancel);
  expect(removal).toBeGreaterThan(dispose);
  expect(kinds.indexOf("accountMerge")).toBeGreaterThan(removal);
}

test("a convert disposition spends the whole balance, not only the offered amount", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(ROUTE);
  stubChain();
  const ops = await build([OFFER], { [ASSET]: "convert" });
  expectCancelThenDisposeThenMerge(ops, "pathPaymentStrictSend");
  const swap = ops.find((o) => o.type === "pathPaymentStrictSend")!;
  expect(swap.sendAmount).toBe(BALANCE);
});

test("an issuer return pays back the whole balance, not only the offered amount", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(NO_MARKET);
  stubChain();
  const ops = await build([OFFER], { [ASSET]: "issuer" });
  expectCancelThenDisposeThenMerge(ops, "payment");
  const payments = ops.filter((o) => o.type === "payment");
  expect(payments).toHaveLength(1);
  expect(payments[0]!.destination).toBe(ISSUER);
  expect(Number(payments[0]!.amount)).toBe(Number(BALANCE));
});

test("a transfer pays the whole balance to the chosen account, not only the offered amount", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(NO_MARKET);
  stubChain();
  const ops = await build([OFFER], { [ASSET]: "transfer" });
  expectCancelThenDisposeThenMerge(ops, "payment");
  const payments = ops.filter((o) => o.type === "payment");
  expect(payments).toHaveLength(1);
  expect(payments[0]!.destination).toBe(TRANSFER_TO);
  expect(Number(payments[0]!.amount)).toBe(Number(BALANCE));
});

test("an unanswered disposition converts the whole balance when a route exists", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(ROUTE);
  stubChain();
  const ops = await build([OFFER], {});
  expectCancelThenDisposeThenMerge(ops, "pathPaymentStrictSend");
  expect(ops.find((o) => o.type === "pathPaymentStrictSend")!.sendAmount).toBe(BALANCE);
});

test("no transaction is built while an asset with no market has no disposition", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(NO_MARKET);
  stubChain();
  const failure = await buildCloseTransactions(state([OFFER]), DEST, {}, "testnet").catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(Error);
});

test("the plan keeps the offer cancellation and the held asset's step as separate steps", () => {
  const plan = buildPlan(state([OFFER]), false, false, {}, undefined, { [ASSET]: "convert" });
  const kinds = plan.steps.map((s) => (s as { type: string }).type);
  expect(kinds).toContain("CANCEL_OFFERS");
  expect(kinds).toContain("HANDLE_ASSETS");
  expect(kinds.indexOf("CANCEL_OFFERS")).toBeLessThan(kinds.indexOf("HANDLE_ASSETS"));
});

test("an offer selling XLM is cancelled before the merge that carries the XLM out", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(ROUTE);
  stubChain();
  const ops = await build([XLM_OFFER], { [ASSET]: "convert" });
  const kinds = types(ops);
  expect(kinds.indexOf("manageSellOffer")).toBeGreaterThanOrEqual(0);
  expect(kinds.indexOf("manageSellOffer")).toBeLessThan(kinds.indexOf("accountMerge"));
  expect(kinds.filter((k) => k === "accountMerge")).toHaveLength(1);
});

// A state the ledger cannot produce: an offer needs a balance to reserve. Pinned so that if a
// reader ever returns one, an empty line is removed and nothing is paid for a phantom amount.
test("an offer over an empty line is cancelled and the line removed with no payment", async () => {
  spyOn(pathFinding, "fetchConversionPath").mockResolvedValue(NO_MARKET);
  stubChain("0.0000000");
  const ops = await build([OFFER], {}, "0.0000000");
  const kinds = types(ops);
  expect(kinds).toContain("manageSellOffer");
  expect(kinds).toContain("changeTrust");
  expect(kinds).not.toContain("payment");
  expect(kinds).not.toContain("pathPaymentStrictSend");
});
