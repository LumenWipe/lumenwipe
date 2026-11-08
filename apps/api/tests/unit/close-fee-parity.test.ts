import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance, Trustline } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { ALL_ON, type KillSwitches } from "@/config/kill-switches";
import { closeFeeShortMessage } from "@/lib/stellar/claim-reserve";
import { stroopsToFixedXlm } from "@/lib/utils/amounts";
import * as rpcModule from "@/lib/stellar/rpc";
import * as registry from "@/lib/exchange-registry";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const ONE_XLM = 10_000_000n;
const RESERVE = 5_000_000n;
const NO_SPONSOR: KillSwitches = { ...ALL_ON, feeSponsorConfigured: false };

let snapshot: Trustline[] = [];

function usdcLine(balance: string): Trustline {
  return {
    asset: USDC,
    balance,
    ...authorizationOf(true),
    issuer: ISSUER,
    code: "USDC",
    limit: "1000",
  };
}

function state(balanceStroops: bigint, over: Partial<AccountState> = {}): AccountState {
  const s: AccountState = {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: stroopsToFixedXlm(balanceStroops),
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
  snapshot = s.trustlines;
  return s;
}

function usdcBalance(hex: string): ClaimableBalance {
  return {
    id: `00000000${hex.repeat(64)}`,
    asset: USDC,
    amount: "10.0000000",
    claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(rpcModule, "pinRpcProvider").mockImplementation(
    (async () => {}) as unknown as typeof rpcModule.pinRpcProvider
  );
  spyOn(registry, "requiresMediatorForAddress").mockReturnValue(false);
});

afterEach(() => mock.restore());

async function refusal(promise: Promise<unknown>): Promise<CloseBuildError> {
  const failure = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(CloseBuildError);
  return failure as CloseBuildError;
}

describe("a claim round that opens a trustline, with no fee sponsor", () => {
  const balance = usdcBalance("a");
  const selections = { [balance.id]: "add_trustline_then_claim" as const };
  const dispositions = { [USDC]: "issuer" as const };
  // The minimum balance is 1 XLM. The claim round pays 200 stroops and its trustline locks one
  // base reserve; the close round after it pays 300 stroops, and its bound counts 400.
  const spare = RESERVE + 400n;
  const beforeClaim = (extra = 0n) =>
    state(ONE_XLM + spare + extra, { claimableBalances: [balance] });
  const afterClaim = (extra = 0n) =>
    state(ONE_XLM + spare + extra - 200n, { trustlines: [usdcLine("10")], numSubEntries: 1 });
  const plan = (s: AccountState) =>
    buildPlan(
      NO_SPONSOR,
      s,
      false,
      false,
      selections,
      undefined,
      dispositions,
      {},
      s.defiPositions,
      false
    );
  const build = (s: AccountState) =>
    buildCloseTransactions(NO_SPONSOR, s, DEST, dispositions, "testnet", null, selections);

  test("the plan reports the shortfall the round after the claim refuses with", async () => {
    const later = await refusal(build(afterClaim()));
    expect(later.code).toBe("close_fee_balance_short");
    expect(later.message).toBe(closeFeeShortMessage(200n));

    const blocker = plan(beforeClaim()).blockers.find((b) => b.code === "close_fee_balance_short");
    expect(blocker?.message).toBe(later.message);
  });

  test("the build refuses before the claim round with the plan's code and amount", async () => {
    const failure = await refusal(build(beforeClaim()));
    expect(failure.code).toBe("close_fee_balance_short");
    expect(failure.status).toBe(422);
    const blocker = plan(beforeClaim()).blockers.find((b) => b.code === failure.code);
    expect(failure.message).toBe(blocker!.message);
  });

  test("topped up by that amount, the plan is clear and both rounds build", async () => {
    expect(plan(beforeClaim(200n)).blockers).toEqual([]);
    const claim = await build(beforeClaim(200n));
    expect(claim.transactions[0]!.covers).toEqual(["ADD_TRUSTLINE_FOR_CLAIM", "CLAIM_BALANCES"]);
    const close = await build(afterClaim(200n));
    expect(close.requiresAnotherCall).toBe(false);
  });

  test("a balance on a trustline the account already holds adds nothing", () => {
    const held = state(ONE_XLM + RESERVE + 600n, {
      trustlines: [usdcLine("0")],
      numSubEntries: 1,
      claimableBalances: [balance],
    });
    expect(plan(held).blockers).toEqual([]);
  });
});
