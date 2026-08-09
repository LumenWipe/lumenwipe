import { test, expect } from "bun:test";
import { claimableSelectionsToDecisions, dispositionsToDecisions } from "@/lib/api/close-decisions";

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
