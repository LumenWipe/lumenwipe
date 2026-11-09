import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance, SponsoredEntry, Trustline } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { ALL_ON } from "@/config/kill-switches";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { authorizationOf } from "./fixtures/trustline";

// The transactions this builder produces for the playground's claimable-balance and
// sponsored-reserve scenarios, kept as fixtures that apps/playground's verifier must accept
// (apps/playground/tests/unit/verify.test.ts):
//
// - claimable: a balance to claim on a trustline the demo holds, one that needs a trustline first,
//   and one locked past the session that the playground forfeits. Two transactions: the claim
//   round, then, once its claims land, the close that returns both assets and merges.
// - sponsoring: the demo pays the reserves of a beneficiary's trustline and data entry; the close
//   revokes both and merges, in one transaction.
//
// Regenerate: UPDATE_PLAYGROUND_RECIPE=1 bun test tests/unit/playground-claims-recipe.test.ts,
// then bun run format from the repository root.

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../playground/tests/fixtures/api-recipe-claims.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_PLAYGROUND_RECIPE === "1";

// Fixed, so the envelopes are byte-identical run to run.
const BUILT_AT_SECONDS = 1_800_000_000;
const key = (n: number): string => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();
const DEMO = key(21);
const SINK = key(22);
const BONUS_ISSUER = key(23);
const GIFT_ISSUER = key(24);
const PERK_ISSUER = key(25);
const BENEFICIARY = key(26);
const BONUS = `BONUS:${BONUS_ISSUER}`;
const GIFT = `GIFT:${GIFT_ISSUER}`;
const PERK = `PERK:${PERK_ISSUER}`;
const balanceId = (fill: string): string => `00000000${fill.repeat(64)}`;
const BONUS_ID = balanceId("1");
const GIFT_ID = balanceId("2");
const LATE_ID = balanceId("3");
const DATA_NAME = "sponsored_by_demo";

function trustline(asset: string, balance: string): Trustline {
  const [code, issuer] = asset.split(":");
  return {
    asset,
    balance,
    limit: "922337203685.4775807",
    ...authorizationOf(true),
    issuer: issuer!,
    code: code!,
  };
}

function balance(id: string, asset: string, amount: string, locked = false): ClaimableBalance {
  // The time-gated balance: claimable by the demo only from two hours after creation, and by its
  // issuer at any time, as the playground creates it.
  const claimants: ClaimableBalance["claimants"] = locked
    ? [
        {
          destination: DEMO,
          predicate: {
            type: "not",
            predicate: {
              type: "before_relative_time",
              relBeforeSeconds: "7200",
              deadlineEpoch: String(BUILT_AT_SECONDS + 7200),
            },
          },
        },
        { destination: BONUS_ISSUER, predicate: { type: "unconditional" } },
      ]
    : [{ destination: DEMO, predicate: { type: "unconditional" } }];
  return { id, asset, amount, claimants, sponsor: asset.split(":")[1] ?? null };
}

function accountState(over: Partial<AccountState>): AccountState {
  return {
    address: DEMO,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "100.0000000",
    dataEntries: [],
    signers: [{ key: DEMO, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
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
    defiPositions: emptyDefiPositionsResult(DEMO),
    defiPositionsWarnings: [],
    ...over,
  };
}

function stubLedger(state: AccountState): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(DEMO, state.sequence)),
    getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime: String(BUILT_AT_SECONDS) }),
    getLedgerEntries: mirrorSnapshot(DEMO, () => state.trustlines),
  })) as unknown as typeof rpcModule.getRpcServer);
}

// The playground's answers (apps/playground/lib/demolish.ts): each recorded balance by its intent,
// every asset returned to its issuer.
const SELECTIONS = {
  [BONUS_ID]: "claim",
  [GIFT_ID]: "add_trustline_then_claim",
  [LATE_ID]: "forfeit",
} as const;
const RETURN_BOTH = { [BONUS]: "issuer", [GIFT]: "issuer" } as const;

async function claimable() {
  const late = balance(LATE_ID, BONUS, "5.0000000", true);
  const before = accountState({
    numSubEntries: 1,
    trustlines: [trustline(BONUS, "0.0000000")],
    claimableBalances: [
      balance(BONUS_ID, BONUS, "50.0000000"),
      balance(GIFT_ID, GIFT, "30.0000000"),
      late,
    ],
  });
  stubLedger(before);
  const claimRound = await buildCloseTransactions(
    ALL_ON,
    before,
    SINK,
    RETURN_BOTH,
    "testnet",
    null,
    SELECTIONS
  );
  // Once the claims land: both balances on their trustlines, only the forfeited balance left.
  const after = accountState({
    sequence: "101",
    numSubEntries: 2,
    trustlines: [trustline(BONUS, "50.0000000"), trustline(GIFT, "30.0000000")],
    claimableBalances: [late],
  });
  stubLedger(after);
  const close = await buildCloseTransactions(ALL_ON, after, SINK, RETURN_BOTH, "testnet", null, {
    [LATE_ID]: "forfeit",
  });
  return {
    name: "claimable",
    selection: {
      scenarios: [
        {
          id: "claimable-balances",
          params: { add_trustline: 1, time_gated: 1, demo_sponsored: 0 },
        },
      ],
    },
    session: {
      demoPublic: DEMO,
      sinkPublic: SINK,
      ephemeralIssuers: [
        { assetCode: "BONUS", publicKey: BONUS_ISSUER },
        { assetCode: "GIFT", publicKey: GIFT_ISSUER },
      ],
      helperAccounts: [],
      claimableBalances: [
        { id: BONUS_ID, asset: BONUS, intent: "claim" },
        { id: GIFT_ID, asset: GIFT, intent: "add_trustline_then_claim" },
        { id: LATE_ID, asset: BONUS, intent: "forfeit" },
      ],
    },
    requiresAnotherCall: [claimRound.requiresAnotherCall, close.requiresAnotherCall],
    transactions: [...claimRound.transactions, ...close.transactions].map((tx) => tx.xdr),
  };
}

const sponsorshipAffordability = await import("@/lib/stellar/sponsorship-affordability");

async function sponsoring() {
  const entries: SponsoredEntry[] = [
    { kind: "trustline", owner: BENEFICIARY, asset: PERK },
    { kind: "data_entry", owner: BENEFICIARY, name: DATA_NAME },
  ];
  const state = accountState({ numSponsoring: 2, sponsoredEntries: entries });
  stubLedger(state);
  // The beneficiary holds enough to take both reserves over.
  spyOn(sponsorshipAffordability, "assessSponsorshipAffordability").mockResolvedValue({
    revocable: entries,
    unverifiedOwners: [],
    unaffordableOwners: new Map(),
  });
  const close = await buildCloseTransactions(ALL_ON, state, SINK, {}, "testnet");
  return {
    name: "sponsoring",
    selection: { scenarios: [{ id: "sponsored-reserves", params: { variant: 1 } }] },
    session: {
      demoPublic: DEMO,
      sinkPublic: SINK,
      ephemeralIssuers: [{ assetCode: "PERK", publicKey: PERK_ISSUER }],
      helperAccounts: [{ role: "beneficiary", publicKey: BENEFICIARY }],
      claimableBalances: [],
    },
    requiresAnotherCall: [close.requiresAnotherCall],
    transactions: close.transactions.map((tx) => tx.xdr),
  };
}

beforeEach(() => {
  setSystemTime(new Date(BUILT_AT_SECONDS * 1000));
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(() => {
    throw new Error("the playground recipe never converts");
  });
});

afterEach(() => {
  mock.restore();
  setSystemTime();
});

test("the claims and sponsoring recipes build the transactions in apps/playground's fixture", async () => {
  const recipes = [await claimable(), await sponsoring()];
  const fixture = { builtAtSeconds: BUILT_AT_SECONDS, recipes };
  if (UPDATE) writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  // Compared as data, so `bun run format` may lay the file out as it likes. On a mismatch,
  // regenerate (see the top of this file), format, and run apps/playground's tests.
  expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fixture);
});

const typesOf = (xdr: string): string[] =>
  TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations.map((op) => op.type);

test("the claimable recipe claims first, then closes; the sponsoring recipe revokes in its close", async () => {
  const claims = await claimable();
  expect(claims.requiresAnotherCall).toEqual([true, false]);
  expect(claims.transactions.map(typesOf)).toEqual([
    ["changeTrust", "claimClaimableBalance", "claimClaimableBalance"],
    ["payment", "payment", "changeTrust", "changeTrust", "accountMerge"],
  ]);
  const revokes = await sponsoring();
  expect(revokes.transactions.map(typesOf)).toEqual([
    ["revokeTrustlineSponsorship", "revokeDataSponsorship", "accountMerge"],
  ]);
});
