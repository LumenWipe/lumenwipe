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

describe("with a fee sponsor, a transaction its rule would not pay", () => {
  const dispositions = { [USDC]: "issuer" as const };
  // One trustline, so the minimum balance is 1.5 XLM. Its payment to the issuer is an operation
  // the sponsor never pays for, so the close's one transaction of three operations, 300 stroops,
  // is the account's own.
  const atMinimum = (extra = 0n) =>
    state(ONE_XLM + RESERVE + extra, { trustlines: [usdcLine("10")], numSubEntries: 1 });
  const plan = (s: AccountState) =>
    buildPlan(ALL_ON, s, false, false, {}, undefined, dispositions, {}, s.defiPositions, false);
  const build = (s: AccountState, selections = {}) =>
    buildCloseTransactions(ALL_ON, s, DEST, dispositions, "testnet", null, selections);

  test("the plan and the build report the same code and amount", async () => {
    const failure = await refusal(build(atMinimum()));
    expect(failure.code).toBe("close_fee_balance_short");
    expect(failure.status).toBe(422);
    expect(failure.message).toBe(closeFeeShortMessage(300n));
    const blocker = plan(atMinimum()).blockers.find((b) => b.code === failure.code);
    expect(blocker?.message).toBe(failure.message);
  });

  test("topped up by that amount, the plan is clear and the account pays the close itself", async () => {
    expect(plan(atMinimum(300n)).blockers).toEqual([]);
    const close = await build(atMinimum(300n));
    expect(close.transactions[0]!.needsSponsoredFee).toBeUndefined();
  });

  test("a claim round ahead is sponsored so the close keeps the XLM it needs", async () => {
    const balance = usdcBalance("b");
    const beforeClaim = state(ONE_XLM + RESERVE + 300n, {
      trustlines: [usdcLine("0")],
      numSubEntries: 1,
      claimableBalances: [balance],
    });
    expect(plan(beforeClaim).blockers).toEqual([]);

    const claim = await build(beforeClaim);
    expect(claim.transactions[0]!.covers).toEqual(["CLAIM_BALANCES"]);
    expect(claim.transactions[0]!.needsSponsoredFee).toBe(true);

    const close = await build(atMinimum(300n));
    expect(close.transactions[0]!.needsSponsoredFee).toBeUndefined();
  });

  test("signer normalization ahead is sponsored so the close keeps the XLM it needs", async () => {
    const cosigner = Keypair.random().publicKey();
    // The cosigner is sponsored by another account, so removing it leaves the minimum balance
    // where it was.
    const multisig = state(ONE_XLM + RESERVE + 300n, {
      signers: [
        { key: SOURCE, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 2, med: 2, high: 2 },
      trustlines: [usdcLine("10")],
      numSubEntries: 2,
      numSponsored: 1,
    });
    expect(plan(multisig).blockers).toEqual([]);

    const normalization = await build(multisig);
    expect(normalization.transactions[0]!.covers).toEqual(["NORMALIZE_SIGNERS"]);
    expect(normalization.transactions[0]!.needsSponsoredFee).toBe(true);

    const close = await build(atMinimum(300n));
    expect(close.transactions[0]!.needsSponsoredFee).toBeUndefined();
  });

  test("a trustline a claim round opens counts its reserve and its payment", async () => {
    const balance = usdcBalance("c");
    const selections = { [balance.id]: "add_trustline_then_claim" as const };
    // The claim round's two operations and the close's three are the account's own, with one
    // base reserve between them.
    const beforeClaim = (extra: bigint) => state(ONE_XLM + extra, { claimableBalances: [balance] });
    const blocker = (s: AccountState) =>
      buildPlan(
        ALL_ON,
        s,
        false,
        false,
        selections,
        undefined,
        dispositions,
        {},
        s.defiPositions
      ).blockers.find((b) => b.code === "close_fee_balance_short");

    expect(blocker(beforeClaim(RESERVE + 499n))?.message).toBe(closeFeeShortMessage(1n));
    const failure = await refusal(build(beforeClaim(RESERVE + 499n), selections));
    expect(failure.message).toBe(closeFeeShortMessage(1n));
    expect(blocker(beforeClaim(RESERVE + 500n))).toBeUndefined();
  });

  test("closes the sponsor pays in full keep their plans unchanged", () => {
    const converting = state(ONE_XLM + RESERVE, { trustlines: [usdcLine("0")], numSubEntries: 1 });
    const withData = state(ONE_XLM + RESERVE, {
      dataEntries: [{ key: "k", value: "dg==" }],
      numSubEntries: 1,
    });
    for (const s of [converting, withData, atMinimum(ONE_XLM)]) {
      expect(plan(s).blockers).toEqual([]);
    }
  });
});

describe("signer normalization first, with later rounds of other kinds", () => {
  const cosigner = Keypair.random().publicKey();
  // The cosigner is sponsored by another account, so the minimum balance is 1 XLM throughout.
  const multisig = (balanceStroops: bigint, over: Partial<AccountState> = {}) =>
    state(balanceStroops, {
      signers: [
        { key: SOURCE, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 2, med: 2, high: 2 },
      numSubEntries: 1,
      numSponsored: 1,
      ...over,
    });

  test("with a Soroban round ahead, the refusal is the own-fee bound, not the classic projection", async () => {
    const token = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    const withToken = multisig(ONE_XLM + 250n, {
      sorobanTokens: {
        tokens: [{ contract: token, balance: "250", symbol: "XTAR", decimals: 7, sources: [] }],
        unreadable: [],
        coverage: [],
        eventsScanned: null,
        warnings: [],
      },
    });
    const dispositions = { [token]: "convert" as const };
    const planned = buildPlan(
      NO_SPONSOR,
      withToken,
      false,
      false,
      {},
      undefined,
      dispositions,
      {},
      withToken.defiPositions,
      false
    ).blockers.find((b) => b.code === "close_fee_balance_short");
    expect(planned).toBeDefined();

    const failure = await refusal(
      buildCloseTransactions(NO_SPONSOR, withToken, DEST, dispositions, "testnet")
    );
    expect(failure.code).toBe("close_fee_balance_short");
    // The normalization round's 200 stroops, the Soroban round at the estimate and the classic
    // bound of 300, from 250 spare; the classic projection alone would have asked for 50.
    expect(failure.message).toBe(closeFeeShortMessage(200n + 100_000n + 300n - 250n));
  });

  test("with a sponsor and a claim round short of its trustline reserve, the build refuses with the plan's code", async () => {
    const balance = usdcBalance("e");
    const selections = { [balance.id]: "add_trustline_then_claim" as const };
    const short = multisig(ONE_XLM + RESERVE, { claimableBalances: [balance] });
    const codes = buildPlan(
      ALL_ON,
      short,
      false,
      false,
      selections,
      undefined,
      {},
      {},
      short.defiPositions
    ).blockers.map((b) => b.code);
    expect(codes).toContain("claimable_balance_reserve_short");

    const failure = await refusal(
      buildCloseTransactions(ALL_ON, short, DEST, {}, "testnet", null, selections)
    );
    expect(codes).toContain(failure.code);
  });
});
