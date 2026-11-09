import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance, CloseTransaction, Trustline } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { ALL_ON, type KillSwitches } from "@/config/kill-switches";
import { closeFeeShortMessage, laterOwnFeesStroops } from "@/lib/stellar/claim-reserve";
import {
  normalizesSignersFirst,
  signerNormalizationOpCount,
} from "@/lib/stellar/tx-builder/signers";
import { BASE_FEE_STROOPS } from "@/config/constants";
import { stroopsToFixedXlm, xlmToStroops } from "@/lib/utils/amounts";
import * as rpcModule from "@/lib/stellar/rpc";
import * as registry from "@/lib/exchange-registry";
import * as conversionModule from "@/lib/close-api/token-conversion-round";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
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

function feeOf(tx: CloseTransaction): bigint {
  return BigInt(TransactionBuilder.fromXDR(tx.xdr, tx.networkPassphrase).fee);
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

  const token = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const dispositions = { [token]: "convert" as const };
  const withToken = (balanceStroops: bigint, over: Partial<AccountState> = {}) =>
    multisig(balanceStroops, {
      sorobanTokens: {
        tokens: [{ contract: token, balance: "250", symbol: "XTAR", decimals: 7, sources: [] }],
        unreadable: [],
        coverage: [],
        eventsScanned: null,
        warnings: [],
      },
      ...over,
    });
  const planShortfall = (s: AccountState) =>
    buildPlan(
      NO_SPONSOR,
      s,
      false,
      false,
      {},
      undefined,
      dispositions,
      {},
      s.defiPositions,
      false
    ).blockers.find((b) => b.code === "close_fee_balance_short");
  const build = (s: AccountState) =>
    buildCloseTransactions(NO_SPONSOR, s, DEST, dispositions, "testnet");
  // The Soroban round at the estimate and the classic bound of 400: the normalization round's two
  // operations, then the master key the next call still lists, and the merge.
  const owed = 100_000n + 400n;
  // What the next call reads once normalization has landed: the master key alone, thresholds
  // reset, the cosigner's sponsored entry gone, and the normalization fee paid.
  const normalized = (s: AccountState, feeStroops: bigint) =>
    withToken(BigInt(xlmToStroops(s.nativeBalanceLumens)) - feeStroops, {
      signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
      thresholds: { low: 0, med: 1, high: 1 },
      numSubEntries: 0,
      numSponsored: 0,
    });

  test("with a Soroban round ahead, the plan and the build report the same code and amount", async () => {
    const short = withToken(ONE_XLM + 250n);
    const planned = planShortfall(short);
    expect(planned?.message).toBe(closeFeeShortMessage(owed - 250n));

    const failure = await refusal(build(short));
    expect(failure.code).toBe("close_fee_balance_short");
    expect(failure.status).toBe(422);
    expect(failure.message).toBe(planned!.message);
  });

  test("with a Soroban round ahead, the build emits normalization exactly when the plan is clear", async () => {
    const oneShort = withToken(ONE_XLM + owed - 1n);
    expect(planShortfall(oneShort)?.message).toBe(closeFeeShortMessage(1n));
    expect((await refusal(build(oneShort))).message).toBe(closeFeeShortMessage(1n));

    const enough = withToken(ONE_XLM + owed);
    expect(planShortfall(enough)).toBeUndefined();
    const round = await build(enough);
    expect(round.transactions[0]!.covers).toEqual(["NORMALIZE_SIGNERS"]);
    expect(round.transactions[0]!.needsSponsoredFee).toBeUndefined();
    const fee = feeOf(round.transactions[0]!);
    expect(fee).toBe(BigInt(BASE_FEE_STROOPS * signerNormalizationOpCount(enough.signers, SOURCE)));
    expect(planShortfall(normalized(enough, fee))).toBeUndefined();
  });

  test.each([
    ["one cosigner", [cosigner]],
    ["two cosigners", [cosigner, Keypair.random().publicKey()]],
  ])(
    "with %s, the bound before normalization covers its fee and the next call's bound",
    (_name, cosigners) => {
      const before = withToken(ONE_XLM, {
        signers: [
          { key: SOURCE, weight: 1, type: "ed25519_public_key" },
          ...cosigners.map((key) => ({ key, weight: 1, type: "ed25519_public_key" as const })),
          { key: StrKey.encodeSha256Hash(Buffer.alloc(32)), weight: 1, type: "hash_x" },
        ],
        thresholds: { low: 9, med: 9, high: 9 },
      });
      expect(normalizesSignersFirst(before)).toBe(true);
      const fee = BigInt(BASE_FEE_STROOPS * signerNormalizationOpCount(before.signers, SOURCE));
      expect(laterOwnFeesStroops(before, 1, false)).toBeGreaterThanOrEqual(
        fee + laterOwnFeesStroops(normalized(before, fee), 1, false)
      );
    }
  );

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

describe("a token conversion round, with no fee sponsor", () => {
  const TOKEN = Address.contract(Buffer.alloc(32, 7)).toString();
  const ROUTER = Address.contract(Buffer.alloc(32, 8)).toString();
  /** A Soroban swap's fee as the Soroswap API sets one; the own-fee check must count it. */
  const CONVERSION_FEE = 52_485n;

  function holdingToken(balanceStroops: bigint): AccountState {
    return state(balanceStroops, {
      sorobanTokens: {
        tokens: [{ contract: TOKEN, balance: "250", symbol: "XTAR", decimals: 7, sources: [] }],
        unreadable: [],
        coverage: [],
        eventsScanned: null,
        warnings: [],
      },
    });
  }

  function swap(): CloseTransaction {
    const tx = new TransactionBuilder(new Account(SOURCE, "100"), {
      fee: CONVERSION_FEE.toString(),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: ROUTER,
          function: "swap_exact_tokens_for_tokens",
          args: [],
        })
      )
      .setTimeout(300)
      .build();
    return {
      id: "tx-1",
      order: 0,
      dependsOn: [],
      xdr: tx.toXDR(),
      networkPassphrase: Networks.TESTNET,
      sourceSequence: "100",
      validUntilLedger: 1060,
      covers: ["HANDLE_ASSETS"],
      coversTargets: [TOKEN],
      intent: {
        ...intentFromXdr(tx.toXDR(), Networks.TESTNET),
        summary: "Exchange 25 XTAR for XLM",
      },
    };
  }

  function convert(s: AccountState) {
    const round = swap();
    const spy = spyOn(conversionModule, "buildTokenConversionRound").mockResolvedValue({
      transaction: round,
      remainingSteps: 0,
    });
    const result = buildCloseTransactions(
      NO_SPONSOR,
      s,
      DEST,
      { [TOKEN]: "convert" },
      "testnet",
      null,
      {},
      {},
      {},
      {},
      { floors: { [TOKEN]: { minAmountOut: "1", provider: "soroswap" } } }
    );
    return { result, round, spy };
  }

  test("short by exactly the round's own fee, the build refuses with that amount", async () => {
    const s = holdingToken(ONE_XLM + laterOwnFeesStroops(holdingToken(0n), 0, false));
    const { result, spy } = convert(s);
    const failure = await refusal(result);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({ code: "close_fee_balance_short", status: 422 });
    expect(failure.message).toBe(closeFeeShortMessage(CONVERSION_FEE));
  });

  test("topped up by that amount, the conversion round builds", async () => {
    const s = holdingToken(
      ONE_XLM + laterOwnFeesStroops(holdingToken(0n), 0, false) + CONVERSION_FEE
    );
    const { result, round, spy } = convert(s);
    const built = await result;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(built.requiresAnotherCall).toBe(true);
    expect(built.transactions).toHaveLength(1);
    expect(built.transactions[0]!.xdr).toBe(round.xdr);
    expect(feeOf(built.transactions[0]!)).toBe(CONVERSION_FEE);
  });
});
