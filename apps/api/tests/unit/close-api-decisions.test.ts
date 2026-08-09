import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  deriveClaimableBalanceDecisionPoints,
  deriveDecisionPoints,
  resolveClaimableBalanceSelections,
  resolveDispositions,
} from "@/lib/close-api/decisions";
import type { AccountState, ClaimableBalance, Trustline } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1234567890",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
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
    ...overrides,
  };
}

function makeTrustline(code: string, balance: string): Trustline {
  return { asset: `${code}:${ISSUER}`, balance, authorized: true, issuer: ISSUER, code };
}

function makeClaimableBalance(id: string, asset: string, amount = "10.0000000"): ClaimableBalance {
  return {
    id,
    asset,
    amount,
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

test("a trustline with a balance produces a convertible asset_disposition decision point", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "10")] });
  const points = deriveDecisionPoints(account, { [`USDC:${ISSUER}`]: true });

  expect(points).toHaveLength(1);
  expect(points[0].type).toBe("asset_disposition");
  expect(points[0].id).toBe(`asset:USDC-${ISSUER}`);
  expect(points[0].options.map((o) => o.id)).toEqual(["convert_to_xlm", "return_to_issuer"]);
  expect(points[0].default).toBe("convert_to_xlm");
});

test("a non-convertible asset offers only return_to_issuer", () => {
  const account = makeAccount({ trustlines: [makeTrustline("FOO", "5")] });
  const points = deriveDecisionPoints(account, { [`FOO:${ISSUER}`]: false });

  expect(points[0].options.map((o) => o.id)).toEqual(["return_to_issuer"]);
  expect(points[0].default).toBe("return_to_issuer");
  expect((points[0].subject as { convertible: boolean }).convertible).toBe(false);
});

test("zero-balance trustlines produce no decision point", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  expect(deriveDecisionPoints(account, {})).toHaveLength(0);
});

test("resolveDispositions maps answers to the assetDispositions record", () => {
  const dispositions = resolveDispositions(
    [{ id: `asset:USDC-${ISSUER}`, choice: "convert_to_xlm" }],
    [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`USDC:${ISSUER}`]: "convert" });
});

test("resolveDispositions maps return_to_issuer to issuer", () => {
  const dispositions = resolveDispositions(
    [{ id: `asset:FOO-${ISSUER}`, choice: "return_to_issuer" }],
    [{ id: `asset:FOO-${ISSUER}`, asset: `FOO:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`FOO:${ISSUER}`]: "issuer" });
});

// ─── deriveClaimableBalanceDecisionPoints ────────────────────────────────────

test("a native claimable balance offers claim/forfeit, defaulting to claim", () => {
  const account = makeAccount({ claimableBalances: [makeClaimableBalance("bal1", "native")] });
  const points = deriveClaimableBalanceDecisionPoints(account);

  expect(points).toHaveLength(1);
  expect(points[0].type).toBe("claimable_balance");
  expect(points[0].id).toBe("claim:bal1");
  expect(points[0].options.map((o) => o.id)).toEqual(["claim", "forfeit"]);
  expect(points[0].default).toBe("claim");
  expect(points[0].required).toBe(true);
  expect((points[0].subject as { currentlyClaimable: boolean }).currentlyClaimable).toBe(true);
});

test("a claimable balance for an authorized trustline asset offers claim/forfeit", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0")],
    claimableBalances: [makeClaimableBalance("bal1", asset)],
  });
  const points = deriveClaimableBalanceDecisionPoints(account);

  expect(points[0].options.map((o) => o.id)).toEqual(["claim", "forfeit"]);
  expect(points[0].default).toBe("claim");
});

test("a claimable balance with no trustline offers add_trustline_then_claim/forfeit, no default", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({ claimableBalances: [makeClaimableBalance("bal1", asset)] });
  const points = deriveClaimableBalanceDecisionPoints(account);

  expect(points[0].options.map((o) => o.id)).toEqual(["add_trustline_then_claim", "forfeit"]);
  expect(points[0].default).toBe("");
  expect((points[0].subject as { currentlyClaimable: boolean }).currentlyClaimable).toBe(false);
});

test("no claimable balances produces no decision points", () => {
  expect(deriveClaimableBalanceDecisionPoints(makeAccount())).toHaveLength(0);
});

test("the subject carries the account's own claim predicate", () => {
  const account = makeAccount({
    claimableBalances: [
      {
        id: "bal1",
        asset: "native",
        amount: "1.0000000",
        claimants: [
          { destination: MASTER, predicate: { type: "before_absolute_time", absBeforeEpoch: "999" } },
        ],
        sponsor: null,
      },
    ],
  });
  const points = deriveClaimableBalanceDecisionPoints(account);
  expect(points[0].subject.predicate).toEqual({
    type: "before_absolute_time",
    absBeforeEpoch: "999",
  });
});

test("the subject defaults to unconditional when the account is not among the claimants", () => {
  const account = makeAccount({
    claimableBalances: [
      {
        id: "bal1",
        asset: "native",
        amount: "1.0000000",
        claimants: [],
        sponsor: null,
      },
    ],
  });
  const points = deriveClaimableBalanceDecisionPoints(account);
  expect(points[0].subject.predicate).toEqual({ type: "unconditional" });
});

// ─── resolveClaimableBalanceSelections ───────────────────────────────────────

test("resolveClaimableBalanceSelections maps claim: answers back by balance id", () => {
  const selections = resolveClaimableBalanceSelections(
    [
      { id: "claim:bal1", choice: "add_trustline_then_claim" },
      { id: "claim:bal2", choice: "forfeit" },
    ],
    ["bal1", "bal2"]
  );
  expect(selections).toEqual({ bal1: "add_trustline_then_claim", bal2: "forfeit" });
});

test("resolveClaimableBalanceSelections ignores unknown balance ids and choices", () => {
  const selections = resolveClaimableBalanceSelections(
    [
      { id: "claim:unknown", choice: "claim" },
      { id: "claim:bal1", choice: "not_a_real_choice" },
      { id: "asset:USDC-X", choice: "convert_to_xlm" },
    ],
    ["bal1"]
  );
  expect(selections).toEqual({});
});
