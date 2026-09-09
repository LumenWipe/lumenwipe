import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  deriveClaimableBalanceDecisionPoints,
  deriveDecisionPoints,
  collectTransferDestinations,
  MissingTransferDestinationError,
  resolveClaimableBalanceSelections,
  resolveDispositions,
  resolveTransferDestinations,
} from "@/lib/close-api/decisions";
import type { AccountState, ClaimableBalance, Trustline } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();

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
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
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
  expect(points[0].options.map((o) => o.id)).toEqual([
    "convert_to_xlm",
    "return_to_issuer",
    "transfer_to_account",
  ]);
  expect(points[0].default).toBe("convert_to_xlm");
});

test("a non-convertible asset still offers transfer alongside return_to_issuer", () => {
  const account = makeAccount({ trustlines: [makeTrustline("FOO", "5")] });
  const points = deriveDecisionPoints(account, { [`FOO:${ISSUER}`]: false });

  // Transferring needs no DEX route, so an asset with no market is not reduced to burning it.
  expect(points[0].options.map((o) => o.id)).toEqual(["return_to_issuer", "transfer_to_account"]);
  expect(points[0].default).toBe("return_to_issuer");
  expect((points[0].subject as { convertible: boolean }).convertible).toBe(false);
});

test("transfer is never the default, because it cannot be resolved without an address", () => {
  const convertible = makeAccount({ trustlines: [makeTrustline("USDC", "10")] });
  const illiquid = makeAccount({ trustlines: [makeTrustline("FOO", "5")] });

  expect(deriveDecisionPoints(convertible, { [`USDC:${ISSUER}`]: true })[0].default).not.toBe(
    "transfer_to_account"
  );
  expect(deriveDecisionPoints(illiquid, { [`FOO:${ISSUER}`]: false })[0].default).not.toBe(
    "transfer_to_account"
  );
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

test("resolveDispositions maps transfer_to_account to transfer", () => {
  const dispositions = resolveDispositions(
    [
      {
        id: `asset:USDC-${ISSUER}`,
        choice: "transfer_to_account",
        params: { destination: DESTINATION },
      },
    ],
    [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`USDC:${ISSUER}`]: "transfer" });
});

// ─── resolveTransferDestinations ─────────────────────────────────────────────
//
// Strictness here is the whole point. Every other unusable answer in this module falls back to a
// safe default; a transfer has none, because both alternatives destroy the balance the caller
// asked to keep. These assert that it refuses rather than quietly picking one.

test("resolveTransferDestinations keys each destination by its own asset", () => {
  const other = Keypair.random().publicKey();
  const destinations = resolveTransferDestinations(
    [
      {
        id: `asset:USDC-${ISSUER}`,
        choice: "transfer_to_account",
        params: { destination: DESTINATION },
      },
      { id: `asset:FOO-${ISSUER}`, choice: "transfer_to_account", params: { destination: other } },
    ],
    [
      { id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` },
      { id: `asset:FOO-${ISSUER}`, asset: `FOO:${ISSUER}` },
    ]
  );
  // Per asset and independent: the contract is not "one destination for the whole close".
  expect(destinations).toEqual({ [`USDC:${ISSUER}`]: DESTINATION, [`FOO:${ISSUER}`]: other });
});

test("a transfer answer with no destination is refused, not defaulted", () => {
  expect(() =>
    resolveTransferDestinations(
      [{ id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account" }],
      [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
    )
  ).toThrow(MissingTransferDestinationError);
});

test("a transfer answer with a malformed destination is refused", () => {
  for (const destination of ["NOTANADDRESS", "", ISSUER.toLowerCase(), ISSUER.slice(0, -1)]) {
    expect(() =>
      resolveTransferDestinations(
        [{ id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account", params: { destination } }],
        [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
      )
    ).toThrow(MissingTransferDestinationError);
  }
});

test("the refusal names the asset, so the caller knows which answer to fix", () => {
  try {
    resolveTransferDestinations(
      [{ id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account" }],
      [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
    );
    throw new Error("expected a refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(MissingTransferDestinationError);
    expect((err as MissingTransferDestinationError).asset).toBe(`USDC:${ISSUER}`);
  }
});

test("non-transfer answers are left alone even when they carry a destination", () => {
  const destinations = resolveTransferDestinations(
    [
      {
        id: `asset:USDC-${ISSUER}`,
        choice: "convert_to_xlm",
        params: { destination: DESTINATION },
      },
      { id: `asset:FOO-${ISSUER}`, choice: "return_to_issuer" },
    ],
    [
      { id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` },
      { id: `asset:FOO-${ISSUER}`, asset: `FOO:${ISSUER}` },
    ]
  );
  expect(destinations).toEqual({});
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
          {
            destination: MASTER,
            predicate: { type: "before_absolute_time", absBeforeEpoch: "999" },
          },
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

// ─── collectTransferDestinations ─────────────────────────────────────────────
//
// The non-throwing form the plan uses. Throwing on the first bad answer meant one typo hid
// every other destination problem in the same close, so the caller fixed one, re-planned, and
// only then met the next.

test("collect reports every asset missing a destination, not just the first", () => {
  const { destinations, missing } = collectTransferDestinations(
    [
      { id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account" },
      { id: `asset:FOO-${ISSUER}`, choice: "transfer_to_account", params: { destination: "nope" } },
    ],
    [
      { id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` },
      { id: `asset:FOO-${ISSUER}`, asset: `FOO:${ISSUER}` },
    ]
  );
  expect(destinations).toEqual({});
  expect(missing.sort()).toEqual([`FOO:${ISSUER}`, `USDC:${ISSUER}`].sort());
});

test("an answer later switched away from transfer is not validated", () => {
  // Answers are last-wins. Keying off "any answer ever said transfer" would refuse a perfectly
  // valid convert-only close over a destination nothing is being paid to.
  const answers = [
    { id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account" },
    { id: `asset:USDC-${ISSUER}`, choice: "convert_to_xlm" },
  ];
  const assets = [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }];

  expect(collectTransferDestinations(answers, assets)).toEqual({ destinations: {}, missing: [] });
  expect(() => resolveTransferDestinations(answers, assets)).not.toThrow();
});

test("a later valid answer clears an earlier malformed one for the same asset", () => {
  const { destinations, missing } = collectTransferDestinations(
    [
      { id: `asset:USDC-${ISSUER}`, choice: "transfer_to_account" },
      {
        id: `asset:USDC-${ISSUER}`,
        choice: "transfer_to_account",
        params: { destination: DESTINATION },
      },
    ],
    [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
  );
  expect(destinations).toEqual({ [`USDC:${ISSUER}`]: DESTINATION });
  expect(missing).toEqual([]);
});

// ─── Assets that arrive through a claim need a disposition too ──────────────
//
// Regression for a close that dead-ended mid-flight. Choosing "add a trustline and claim it"
// for a balance the account holds no trustline for meant the asset existed nowhere in
// `account.trustlines` at plan time, so no disposition decision was derived and the caller
// never answered one. The claim round then created the trustline and filled it, and the very
// next round refused with `needs_decisions` for an asset the caller was never asked about -
// after the trustline had already been added and the balance claimed.
//
// The plan lied about it too: it showed "add trustline -> claim -> merge" with no conversion
// and no trustline removal, which is not a close that could ever have succeeded.

test("a balance being claimed via a new trustline gets its own asset_disposition decision", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    claimableBalances: [makeClaimableBalance("cb1", asset, "5.0000000")],
  });

  const points = deriveDecisionPoints(
    account,
    { [asset]: true },
    { cb1: "add_trustline_then_claim" }
  );

  const disposition = points.find((p) => p.type === "asset_disposition");
  expect(disposition).toBeDefined();
  expect(disposition!.subject).toMatchObject({ asset, balance: "5.0000000" });
  expect(disposition!.default).toBe("convert_to_xlm");
});

test("an unresolved or forfeited balance produces no disposition decision", () => {
  // Nothing arrives, so there is nothing to decide about. Only the remediation choice itself
  // is pending, and that decision is derived elsewhere.
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    claimableBalances: [makeClaimableBalance("cb1", asset, "5.0000000")],
  });

  expect(deriveDecisionPoints(account, { [asset]: true }, {})).toHaveLength(0);
  expect(deriveDecisionPoints(account, { [asset]: true }, { cb1: "forfeit" })).toHaveLength(0);
});

test("a claimed asset with no route defaults to the issuer, like any other illiquid asset", () => {
  const asset = `JUNK:${ISSUER}`;
  const account = makeAccount({
    claimableBalances: [makeClaimableBalance("cb1", asset, "3.0000000")],
  });

  const points = deriveDecisionPoints(
    account,
    { [asset]: false },
    { cb1: "add_trustline_then_claim" }
  );

  expect(points[0]!.default).toBe("return_to_issuer");
});

test("an asset already trusted is not decided twice", () => {
  // The trustline branch already covers it: claiming tops up a line that exists, and the
  // caller has been answering for that asset all along.
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "2.0000000")],
    claimableBalances: [makeClaimableBalance("cb1", asset, "5.0000000")],
  });

  const points = deriveDecisionPoints(account, { [asset]: true }, { cb1: "claim" });

  expect(points.filter((p) => p.type === "asset_disposition")).toHaveLength(1);
});

test("a native balance being claimed needs no disposition", () => {
  // XLM is the thing everything converts *to*; there is no trustline and nothing to decide.
  const account = makeAccount({
    claimableBalances: [makeClaimableBalance("cb1", "native", "5.0000000")],
  });

  expect(deriveDecisionPoints(account, {}, { cb1: "add_trustline_then_claim" })).toHaveLength(0);
});

// ─── Review findings: every claimed asset needs a decision, exactly once ────
//
// Two reviewers independently caught the branch gap: a trustline that exists with balance 0
// and is filled by a plain "claim" matched neither derivation branch - not arriving (the asset
// is trusted), not pending (zero balance) - so the close 422'd at round 2 for a decision the
// caller was never offered. And two claimable balances of one asset derived two decision
// points with the same id.

test("a zero-balance trustline topped up by a claim gets a disposition decision", () => {
  const asset = `EURC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("EURC", "0")],
    claimableBalances: [makeClaimableBalance("cb1", asset, "4.0000000")],
  });

  const points = deriveDecisionPoints(account, { [asset]: true }, { cb1: "claim" });

  const disposition = points.find((p) => p.type === "asset_disposition");
  expect(disposition).toBeDefined();
  expect(disposition!.subject).toMatchObject({ asset, balance: "4.0000000" });
});

test("a currently-claimable balance left unanswered still yields the decision", () => {
  // Claiming is the opt-out default: buildPlan claims every currently-claimable balance not
  // explicitly forfeited, so the disposition must be derived on the same rule - an unanswered
  // claim is a claim.
  const asset = `EURC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("EURC", "0")],
    claimableBalances: [makeClaimableBalance("cb1", asset, "4.0000000")],
  });

  expect(deriveDecisionPoints(account, { [asset]: true }, {})).toHaveLength(1);
});

test("a forfeited top-up of a zero-balance trustline yields no decision", () => {
  const asset = `EURC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("EURC", "0")],
    claimableBalances: [makeClaimableBalance("cb1", asset, "4.0000000")],
  });

  expect(deriveDecisionPoints(account, { [asset]: true }, { cb1: "forfeit" })).toHaveLength(0);
});

test("two claimable balances of one asset derive one decision, with the summed amount", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    claimableBalances: [
      makeClaimableBalance("cb1", asset, "5.0000000"),
      makeClaimableBalance("cb2", asset, "2.5000000"),
    ],
  });

  const points = deriveDecisionPoints(
    account,
    { [asset]: true },
    {
      cb1: "add_trustline_then_claim",
      cb2: "add_trustline_then_claim",
    }
  );

  expect(points).toHaveLength(1);
  expect(points[0]!.subject).toMatchObject({ asset, balance: "7.5000000" });
});

test("a claim topping a positive-balance trustline does not decide the asset twice", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "2.0000000")],
    claimableBalances: [makeClaimableBalance("cb1", asset, "5.0000000")],
  });

  const points = deriveDecisionPoints(account, { [asset]: true }, { cb1: "claim" });

  expect(points.filter((p) => p.type === "asset_disposition")).toHaveLength(1);
});
