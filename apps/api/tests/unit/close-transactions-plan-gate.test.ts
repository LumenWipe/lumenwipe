import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, PlanBlocker, SponsoredEntry, Trustline } from "@lumenwipe/types";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import * as rpcModule from "@/lib/stellar/rpc";
import { ALL_ON } from "@/config/kill-switches";
import { buildCloseTransactions, planRefusal } from "@/lib/close-api/build-transactions";

// `close/transactions` rebuilds the plan and refuses every blocker except the few it is built
// past on purpose, before any round. Without that, a caller that never read /close/plan got a
// close whose merge fails on chain, after its earlier rounds had already landed.
//
// The affordability read is patched with spyOn on the real module object, never mock.module,
// which would replace the module for the whole `bun test` process and leak into other files.

const SOURCE = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const SPONSORED: SponsoredEntry = { kind: "trustline", owner: OWNER, asset: USDC };

const sponsorshipAffordability = await import("@/lib/stellar/sponsorship-affordability");

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
});

afterEach(() => {
  mock.restore();
});

let snapshot: Trustline[] = [];
function state(over: Partial<AccountState> = {}): AccountState {
  const s: AccountState = {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
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

function stubRpc(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot),
  })) as unknown as typeof rpcModule.getRpcServer);
}

function unaffordable() {
  return spyOn(sponsorshipAffordability, "assessSponsorshipAffordability").mockResolvedValue({
    revocable: [],
    unverifiedOwners: [],
    unaffordableOwners: new Map([[OWNER, { entries: [SPONSORED], shortfallXlm: "1.0000000" }]]),
  });
}

function usdcBalance(hexChar: string) {
  return {
    id: `00000000${hexChar.repeat(64)}`,
    asset: USDC,
    amount: "10.0000000",
    claimants: [{ destination: SOURCE, predicate: { type: "unconditional" as const } }],
    sponsor: null,
  };
}

describe("close/transactions refuses a plan blocker the merge cannot get past", () => {
  const cases: Array<[string, () => AccountState]> = [
    ["account_auth_immutable", () => state({ authImmutable: true })],
    [
      "sponsorship_unenumerated",
      () => state({ numSponsoring: 2, sponsorshipEnumerationIncomplete: true }),
    ],
    [
      "sponsorship_claimable_balance_unrevocable",
      () =>
        state({
          numSponsoring: 1,
          sponsoredEntries: [{ kind: "claimable_balance", balanceId: "00".repeat(36) }],
        }),
    ],
    [
      "liquidity_pool_shares_held",
      () => state({ numSubEntries: 2, poolShares: [{ poolId: "a".repeat(64) }] }),
    ],
    ["subentries_unenumerated", () => state({ numSubEntries: 3, subEntryMismatch: true })],
    // The claim round refuses both of these too; the gate refuses them before any round.
    [
      "claimable_balance_reserve_short",
      () => state({ nativeBalanceLumens: "1.0000000", claimableBalances: [usdcBalance("a")] }),
    ],
    ["claimable_balances_too_many", () => state({ claimableBalancesMore: true })],
  ];

  for (const [code, make] of cases) {
    test(`${code} is refused with its own code`, async () => {
      stubRpc();
      const s = make();
      const selections = Object.fromEntries(
        s.claimableBalances.map((b) => [b.id, "add_trustline_then_claim" as const])
      );
      await expect(
        buildCloseTransactions(ALL_ON, s, DEST, {}, "testnet", null, selections)
      ).rejects.toMatchObject({ code, status: 422 });
    });
  }

  test("sponsorship_unaffordable is refused with its own code", async () => {
    stubRpc();
    const read = unaffordable();
    await expect(
      buildCloseTransactions(
        ALL_ON,
        state({ numSponsoring: 1, sponsoredEntries: [SPONSORED] }),
        DEST,
        {},
        "testnet"
      )
    ).rejects.toMatchObject({ code: "sponsorship_unaffordable", status: 422 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("an unaffordable sponsorship refuses the signer normalization round ahead of the close", async () => {
    stubRpc();
    unaffordable();
    const cosigner = Keypair.random().publicKey();
    const s = state({
      numSponsoring: 1,
      numSubEntries: 1,
      sponsoredEntries: [SPONSORED],
      signers: [
        { key: SOURCE, weight: 1, type: "ed25519_public_key" },
        { key: cosigner, weight: 1, type: "ed25519_public_key" },
      ],
      thresholds: { low: 2, med: 2, high: 2 },
    });
    await expect(buildCloseTransactions(ALL_ON, s, DEST, {}, "testnet")).rejects.toMatchObject({
      code: "sponsorship_unaffordable",
    });
  });

  test("an unaffordable sponsorship refuses the claim round ahead of the close", async () => {
    stubRpc();
    unaffordable();
    const balance = usdcBalance("b");
    const s = state({
      numSponsoring: 1,
      sponsoredEntries: [SPONSORED],
      claimableBalances: [balance],
    });
    await expect(
      buildCloseTransactions(ALL_ON, s, DEST, {}, "testnet", null, {
        [balance.id]: "add_trustline_then_claim",
      })
    ).rejects.toMatchObject({ code: "sponsorship_unaffordable" });
  });
});

describe("close/transactions and a sponsored account that could not be read", () => {
  const sponsoring = () => state({ numSponsoring: 1, sponsoredEntries: [SPONSORED] });

  test("the failed read refuses the build with sponsorship_unverified", async () => {
    stubRpc();
    spyOn(sponsorshipAffordability, "assessSponsorshipAffordability").mockResolvedValue({
      revocable: [],
      unaffordableOwners: new Map(),
      unverifiedOwners: [OWNER],
    });
    await expect(
      buildCloseTransactions(ALL_ON, sponsoring(), DEST, {}, "testnet")
    ).rejects.toMatchObject({ code: "sponsorship_unverified", status: 422 });
  });

  test("a successful read of the same state builds the revoke and the merge", async () => {
    stubRpc();
    spyOn(sponsorshipAffordability, "assessSponsorshipAffordability").mockResolvedValue({
      revocable: [SPONSORED],
      unaffordableOwners: new Map(),
      unverifiedOwners: [],
    });
    const result = await buildCloseTransactions(ALL_ON, sponsoring(), DEST, {}, "testnet");
    const types = result.transactions.flatMap((t) =>
      TransactionBuilder.fromXDR(t.xdr, Networks.TESTNET).operations.map((op) => op.type)
    );
    expect(types).toContain("revokeTrustlineSponsorship");
    expect(types).toContain("accountMerge");
  });
});

describe("close/transactions builds past the blockers it allows", () => {
  test("a forfeited claimable balance still closes the account", async () => {
    stubRpc();
    const balance = usdcBalance("c");
    const result = await buildCloseTransactions(
      ALL_ON,
      state({ claimableBalances: [balance] }),
      DEST,
      {},
      "testnet",
      null,
      { [balance.id]: "forfeit" }
    );
    const ops = TransactionBuilder.fromXDR(
      result.transactions[0]!.xdr,
      Networks.TESTNET
    ).operations;
    expect(ops.some((op) => op.type === "accountMerge")).toBe(true);
  });
});

describe("planRefusal", () => {
  const refusalOf = (blockers: PlanBlocker[]) => {
    const refusal = planRefusal(blockers);
    return refusal && { code: refusal.code, status: refusal.status, message: refusal.message };
  };

  test("passes the blockers the close is built past", () => {
    expect(
      refusalOf([
        { code: "claimable_balance_forfeited", message: "forfeit" },
        { code: "defi_position_left_behind", message: "left" },
        { code: "close_fee_balance_short", message: "fees" },
        { code: "defi_positions_unconfirmed_no_trustlines", message: "a" },
        { code: "defi_positions_unconfirmed_but_detected", message: "b" },
        { code: "defi_positions_unconfirmed_user_verified", message: "c" },
      ])
    ).toBeNull();
  });

  test("refuses a registered code under that code", () => {
    expect(refusalOf([{ code: "sponsorship_unaffordable", message: "short" }])).toEqual({
      code: "sponsorship_unaffordable",
      status: 422,
      message: "short",
    });
  });

  test("refuses an unclaimable balance under the claim round's code", () => {
    expect(refusalOf([{ code: "claimable_balance_unclaimable", message: "m" }])?.code).toBe(
      "claimable_balance_not_claimable_now"
    );
  });

  test("fails closed on a blocker without a code", () => {
    expect(refusalOf([{ message: "new blocker" }])).toEqual({
      code: "unprocessable_entity",
      status: 422,
      message: "new blocker",
    });
  });

  test("fails closed on a code the registry does not know", () => {
    expect(refusalOf([{ code: "some_future_blocker", message: "new" }])).toEqual({
      code: "unprocessable_entity",
      status: 422,
      message: "new",
    });
  });

  test("refuses the first blocker it cannot pass, after any it can", () => {
    expect(
      refusalOf([
        { code: "claimable_balance_forfeited", message: "forfeit" },
        { code: "account_auth_immutable", message: "immutable" },
      ])?.code
    ).toBe("account_auth_immutable");
  });
});
