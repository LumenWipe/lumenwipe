import { test, expect } from "bun:test";
import {
  chosenTransfers,
  claimAnswersKey,
  claimableSelectionsToDecisions,
  destinationAcknowledgementToDecisions,
  dispositionsToDecisions,
} from "@/lib/api/close-decisions";

const ASSET = "USDC:GISSUER0000000000000000000000000000000000000000000000000000";
// Must match the API's assetDecisionId contract: "asset:" + first ":" replaced with "-".
const ASSET_ID = `asset:${ASSET.replace(":", "-")}`;

const BALANCE_ID = "00000000abc";
// Must match the API's claimableBalanceDecisionId contract: "claim:" + the balance id.
const BALANCE_DECISION_ID = `claim:${BALANCE_ID}`;

test("dispositionsToDecisions › maps convert → convert_to_xlm with the API decision id", () => {
  expect(dispositionsToDecisions({ [ASSET]: "convert" })).toEqual([
    { id: ASSET_ID, choice: "convert_to_xlm" },
  ]);
});

test("dispositionsToDecisions › maps issuer → return_to_issuer", () => {
  expect(dispositionsToDecisions({ [ASSET]: "issuer" })).toEqual([
    { id: ASSET_ID, choice: "return_to_issuer" },
  ]);
});

test("dispositionsToDecisions › empty dispositions → empty decisions", () => {
  expect(dispositionsToDecisions({})).toEqual([]);
});

test("claimableSelectionsToDecisions › maps a selection to its decision id and choice verbatim", () => {
  expect(claimableSelectionsToDecisions({ [BALANCE_ID]: "add_trustline_then_claim" })).toEqual([
    { id: BALANCE_DECISION_ID, choice: "add_trustline_then_claim" },
  ]);
});

test("claimableSelectionsToDecisions › maps multiple selections", () => {
  expect(claimableSelectionsToDecisions({ bal1: "claim", bal2: "forfeit" })).toEqual([
    { id: "claim:bal1", choice: "claim" },
    { id: "claim:bal2", choice: "forfeit" },
  ]);
});

test("claimableSelectionsToDecisions › empty selections → empty decisions", () => {
  expect(claimableSelectionsToDecisions({})).toEqual([]);
});

// ─── destination acknowledgement ─────────────────────────────────────────────

const DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_DEST = "GAK5Q2SDKTMFMO3EUEKWAFRB2QPH4W5WU6X6RIWRN4MNNTSOUKUB6YVX";
// Must match the API's destinationDecisionId / DESTINATION_ACK_CHOICE. The id names the
// address so an answer cannot be replayed for a different destination.
const destinationDecisionId = (address: string) => `destination:${address}`;
const DESTINATION_ACK_CHOICE = "i_control_this_address";

test("destinationAcknowledgementToDecisions › emits the API's decision id and choice", () => {
  expect(destinationAcknowledgementToDecisions(DEST, DEST)).toEqual([
    { id: destinationDecisionId(DEST), choice: DESTINATION_ACK_CHOICE },
  ]);
});

test("destinationAcknowledgementToDecisions › emits nothing when nothing was acknowledged", () => {
  expect(destinationAcknowledgementToDecisions(null, DEST)).toEqual([]);
});

// The acknowledgement is recorded as the address it was given for precisely so it cannot be
// reused: confirming control of one address says nothing about another. Editing the destination
// after ticking the box must not carry the confirmation across.
test("destinationAcknowledgementToDecisions › does not carry an acknowledgement to a different destination", () => {
  expect(destinationAcknowledgementToDecisions(OTHER_DEST, DEST)).toEqual([]);
});

test("destinationAcknowledgementToDecisions › emits nothing without a destination", () => {
  expect(destinationAcknowledgementToDecisions(DEST, null)).toEqual([]);
  expect(destinationAcknowledgementToDecisions(null, null)).toEqual([]);
});

// ─── transfer disposition (#111) ─────────────────────────────────────────────

const EURC = "EURC:GISSUER0000000000000000000000000000000000000000000000000000";
const EURC_ID = `asset:${EURC.replace(":", "-")}`;
const DEST_A = "GA".padEnd(56, "A");
const DEST_B = "GB".padEnd(56, "B");

test("a transfer disposition sends the transfer choice with its destination", () => {
  const answers = dispositionsToDecisions({ [ASSET]: "transfer" }, { [ASSET]: DEST_A });
  expect(answers).toEqual([
    { id: ASSET_ID, choice: "transfer_to_account", params: { destination: DEST_A } },
  ]);
});

test("a transfer is never mapped onto return_to_issuer", () => {
  const answers = dispositionsToDecisions({ [ASSET]: "transfer" }, { [ASSET]: DEST_A });
  // The previous ternary mapped everything that was not "convert" onto burning the asset, so
  // choosing to keep a balance would have destroyed it. This is that regression.
  expect(answers[0]!.choice).not.toBe("return_to_issuer");
});

test("each asset carries its own destination", () => {
  const answers = dispositionsToDecisions(
    { [ASSET]: "transfer", [EURC]: "transfer" },
    { [ASSET]: DEST_A, [EURC]: DEST_B }
  );
  const byId = new Map(answers.map((x) => [x.id, x.params?.destination]));
  expect(byId.get(ASSET_ID)).toBe(DEST_A);
  expect(byId.get(EURC_ID)).toBe(DEST_B);
});

test("a transfer with no destination emits no destination, leaving the API to refuse", () => {
  const answers = dispositionsToDecisions({ [ASSET]: "transfer" }, {});
  // Emitting a wrong-but-present destination would be worse than emitting none: the API can
  // refuse a missing one, but a plausible one would be built and signed.
  expect(answers[0]!.params?.destination).toBeUndefined();
});

test("convert and issuer are unchanged by the transfer support", () => {
  const answers = dispositionsToDecisions({ [ASSET]: "convert", [EURC]: "issuer" });
  expect(answers.map((a) => a.choice)).toEqual(["convert_to_xlm", "return_to_issuer"]);
});

// ─── The key that stopped the analyze page retriggering itself ──────────────

test("claimAnswersKey › a rebuilt object with the same answers keys the same", () => {
  // The exact shape that caused the loop: the store hands back a fresh object on every account
  // read. Same answers must mean the same key, or the fetch that produced it runs again.
  const a = { cb1: "claim" as const, cb2: "forfeit" as const };
  const rebuilt = { ...a };

  expect(rebuilt).not.toBe(a);
  expect(claimAnswersKey(rebuilt)).toBe(claimAnswersKey(a));
});

test("claimAnswersKey › insertion order does not change the key", () => {
  expect(claimAnswersKey({ cb2: "forfeit", cb1: "claim" })).toBe(
    claimAnswersKey({ cb1: "claim", cb2: "forfeit" })
  );
});

test("claimAnswersKey › a changed answer changes the key", () => {
  const before = claimAnswersKey({ cb1: "forfeit" });
  const after = claimAnswersKey({ cb1: "add_trustline_then_claim" });

  expect(after).not.toBe(before);
});

test("claimAnswersKey › a new answer changes the key", () => {
  expect(claimAnswersKey({ cb1: "claim", cb2: "forfeit" })).not.toBe(
    claimAnswersKey({ cb1: "claim" })
  );
});

test("claimAnswersKey › no answers is a stable empty key", () => {
  expect(claimAnswersKey({})).toBe("");
});

// ─── Review finding: a transfer of an arriving asset must reach verify() ─────
//
// chosenTransfers built the expected transfers from accountState.trustlines alone, so an asset
// arriving through add_trustline_then_claim - which has no trustline in the state captured at
// run start - never produced an entry. verify() then rejected round 2's payment as "an
// unexpected address": trustline added, balance claimed, close dead mid-flight.

const ACCOUNT_BASE = {
  address: "GSOURCE",
  network: "testnet" as const,
  sequence: "1",
  nativeBalanceLumens: "10.0000000",
  dataEntries: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
  numSubEntries: 0,
  numSponsoring: 0,
  sponsoredEntries: [],
  sponsorshipEnumerationIncomplete: false,
  sponsoredBy: null,
  authImmutable: false,
  trustlines: [],
  openOffers: [],
  poolShares: [],
  claimableBalances: [],
  subEntryMismatch: false,
};

test("chosenTransfers › an asset arriving via a remediated claim gets its floor from the claim", () => {
  const asset = "USDC:GISSUER";
  const transfers = chosenTransfers(
    { [asset]: "transfer" },
    { [asset]: "GDEST" },
    {
      ...ACCOUNT_BASE,
      claimableBalances: [
        {
          id: "cb1",
          asset,
          amount: "5.0000000",
          claimants: [{ destination: "GSOURCE", predicate: { type: "unconditional" } }],
          sponsor: null,
        },
      ],
    },
    { cb1: "add_trustline_then_claim" }
  );

  expect(transfers[asset]).toEqual({ destination: "GDEST", amount: "5.0000000" });
});

test("chosenTransfers › a held balance topped up by a claim floors at the sum", () => {
  const asset = "USDC:GISSUER";
  const transfers = chosenTransfers(
    { [asset]: "transfer" },
    { [asset]: "GDEST" },
    {
      ...ACCOUNT_BASE,
      trustlines: [
        {
          asset,
          balance: "2.0000000",
          limit: "100",
          authorized: true,
          issuer: "GISSUER",
          code: "USDC",
        },
      ],
      claimableBalances: [
        {
          id: "cb1",
          asset,
          amount: "5.0000000",
          claimants: [{ destination: "GSOURCE", predicate: { type: "unconditional" } }],
          sponsor: null,
        },
      ],
    },
    { cb1: "claim" }
  );

  expect(transfers[asset]!.amount).toBe("7.0000000");
});

test("chosenTransfers › a forfeited balance contributes nothing", () => {
  const asset = "USDC:GISSUER";
  const transfers = chosenTransfers(
    { [asset]: "transfer" },
    { [asset]: "GDEST" },
    {
      ...ACCOUNT_BASE,
      claimableBalances: [
        {
          id: "cb1",
          asset,
          amount: "5.0000000",
          claimants: [{ destination: "GSOURCE", predicate: { type: "unconditional" } }],
          sponsor: null,
        },
      ],
    },
    { cb1: "forfeit" }
  );

  expect(transfers[asset]).toBeUndefined();
});
