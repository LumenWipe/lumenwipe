import { test, expect } from "bun:test";
import { dispositionsToDecisions } from "@/lib/api/close-decisions";

const ASSET = "USDC:GISSUER0000000000000000000000000000000000000000000000000000";
// Must match the API's assetDecisionId contract: "asset:" + first ":" replaced with "-".
const ASSET_ID = `asset:${ASSET.replace(":", "-")}`;

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
