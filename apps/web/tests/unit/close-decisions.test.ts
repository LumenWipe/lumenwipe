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
  expect(
    claimableSelectionsToDecisions({ bal1: "claim", bal2: "forfeit" })
  ).toEqual([
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
// Must match the API's DESTINATION_DECISION_ID / DESTINATION_ACK_CHOICE.
const DESTINATION_DECISION_ID = "destination:unrecognized";
const DESTINATION_ACK_CHOICE = "i_control_this_address";

test("destinationAcknowledgementToDecisions › emits the API's decision id and choice", () => {
  expect(destinationAcknowledgementToDecisions(DEST, DEST)).toEqual([
    { id: DESTINATION_DECISION_ID, choice: DESTINATION_ACK_CHOICE },
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
