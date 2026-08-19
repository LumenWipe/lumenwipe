import { test, expect } from "bun:test";
import {
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
