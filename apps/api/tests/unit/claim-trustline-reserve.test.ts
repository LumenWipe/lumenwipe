import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance } from "@lumenwipe/types";
import { trustlineReserveShortfallStroops } from "@/lib/stellar/claim-reserve";
import { deriveClaimableBalanceDecisionPoints } from "@/lib/close-api/decisions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { ledgerEntries } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import * as rpcModule from "@/lib/stellar/rpc";

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
});
afterEach(() => mock.restore());

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const EURC = `EURC:${ISSUER}`;

function balance(n: number, asset: string): ClaimableBalance {
  return {
    id: `00000000${n.toString(16).padStart(64, "0")}`,
    asset,
    amount: "5.0000000",
    claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

function state(native: string, balances: ClaimableBalance[], over: Partial<AccountState> = {}) {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: native,
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
    claimableBalances: balances,
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ledgerCloseTime: 1_800_000_000,
    ...over,
  } as AccountState;
}

// Confirmed on testnet: an account holding 1.4 XLM (minimum 1.0) that submits
// [changeTrust(asset), claimClaimableBalance] gets tx_failed with
// ["op_low_reserve", "op_no_trust"], so the claim is lost with the trustline. At 1.5000199 XLM
// the same transaction fails, at 1.5000200 XLM (1.0 reserve + 0.5 new trustline + 2 x 100 stroop
// fees) it succeeds.
test("shortfall › matches the ledger boundary observed on testnet", () => {
  expect(trustlineReserveShortfallStroops(state("1.5000199", []), 1, 1)).toBe(1n);
  expect(trustlineReserveShortfallStroops(state("1.5000200", []), 1, 1)).toBe(0n);
  expect(trustlineReserveShortfallStroops(state("1.4000000", []), 1, 1)).toBe(1_000_200n);
});

test("shortfall › open sell offers hold XLM back, existing sub-entries raise the minimum", () => {
  const offer = {
    id: "1",
    selling: "native",
    buying: USDC,
    amount: "2.0000000",
    price: "1",
  };
  expect(
    trustlineReserveShortfallStroops(state("2.5000200", [], { openOffers: [offer] }), 1, 1)
  ).toBe(10_000_000n);
  expect(trustlineReserveShortfallStroops(state("2.5000199", [], { numSubEntries: 2 }), 1, 1)).toBe(
    1n
  );
});

test("shortfall › the round's fees are the account's own, since no sponsor pays for a new trustline", () => {
  expect(trustlineReserveShortfallStroops(state("1.0000000", []), 1, 1)).toBe(5_000_200n);
});

test("shortfall › reserves another account pays for lower the minimum", () => {
  expect(
    trustlineReserveShortfallStroops(
      state("1.0000200", [], { numSubEntries: 2, numSponsored: 2 }),
      1,
      1
    )
  ).toBe(5_000_000n);
  expect(trustlineReserveShortfallStroops(state("0.5000200", [], { numSponsored: 2 }), 1, 1)).toBe(
    0n
  );
});

test("decisions › an account at its minimum is not offered add_trustline_then_claim and is told the shortfall", () => {
  const [d] = deriveClaimableBalanceDecisionPoints(state("1.0000000", [balance(1, USDC)]));
  expect(d!.options.map((o) => o.id)).toEqual(["forfeit"]);
  expect(d!.options[0]!.note).toContain("USDC trustline needs 0.5000200 XLM");
});

test("decisions › an account with headroom keeps both options", () => {
  const [d] = deriveClaimableBalanceDecisionPoints(state("5.0000000", [balance(1, USDC)]));
  expect(d!.options.map((o) => o.id)).toEqual(["add_trustline_then_claim", "forfeit"]);
});

test("plan › the shortfall is a blocker, and the unanswered balance names it", () => {
  const b = balance(1, USDC);
  const unanswered = buildPlan(state("1.0000000", [b]), false);
  expect(unanswered.blockers[0]!.message).toContain("0.5000200 XLM");

  const chosen = buildPlan(state("1.0000000", [b]), false, false, {
    [b.id]: "add_trustline_then_claim",
  });
  expect(chosen.blockers.map((x) => x.code)).toContain("claimable_balance_reserve_short");
});

test("plan › several balances of one asset share one new reserve", () => {
  const same = [balance(1, USDC), balance(2, USDC), balance(3, USDC)];
  const answers = Object.fromEntries(same.map((b) => [b.id, "add_trustline_then_claim" as const]));
  // 1.0 reserve + 0.5 for ONE trustline + 4 ops x 100 stroops of fees
  const enough = buildPlan(state("1.5000400", same), false, false, answers);
  expect(enough.blockers.map((x) => x.code)).not.toContain("claimable_balance_reserve_short");

  const two = [balance(1, USDC), balance(2, EURC)];
  const twoAnswers = Object.fromEntries(
    two.map((b) => [b.id, "add_trustline_then_claim" as const])
  );
  const short = buildPlan(state("1.5000400", two), false, false, twoAnswers);
  expect(short.blockers.map((x) => x.code)).toContain("claimable_balance_reserve_short");
});

function rpcStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime: "1800000000" }),
    getLedgerEntries: ledgerEntries({}),
  };
}

async function build(s: AccountState, selections: Record<string, "add_trustline_then_claim">) {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  return buildCloseTransactions(s, DEST, {}, "testnet", null, selections);
}

test("builder › an account at its minimum is refused with the shortfall instead of a reverting round", async () => {
  const b = balance(1, USDC);
  await expect(
    build(state("1.0000000", [b]), { [b.id]: "add_trustline_then_claim" })
  ).rejects.toMatchObject({ code: "claimable_balance_reserve_short" });
});

test("builder › an account with headroom builds the trustline and the claim as before", async () => {
  const same = [balance(1, USDC), balance(2, USDC)];
  const answers = Object.fromEntries(same.map((b) => [b.id, "add_trustline_then_claim" as const]));
  const r = await build(state("1.5000400", same), answers);
  const types = r.transactions.flatMap((t) =>
    TransactionBuilder.fromXDR(t.xdr, Networks.TESTNET).operations.map((o) => o.type)
  );
  expect(types.filter((t) => t === "changeTrust")).toHaveLength(1);
  expect(types.filter((t) => t === "claimClaimableBalance")).toHaveLength(2);
});
