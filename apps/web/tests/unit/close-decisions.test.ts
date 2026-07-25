import { test, expect } from "bun:test";
import { dispositionsToDecisions } from "@/lib/api/close-decisions";
import { assetDecisionId } from "@/lib/close-api/decisions";

const ASSET = "USDC:GISSUER0000000000000000000000000000000000000000000000000000";

test("dispositionsToDecisions › maps convert → convert_to_xlm with the API decision id", () => {
  expect(dispositionsToDecisions({ [ASSET]: "convert" })).toEqual([
    { id: assetDecisionId(ASSET), choice: "convert_to_xlm" },
  ]);
});

test("dispositionsToDecisions › maps issuer → return_to_issuer", () => {
  expect(dispositionsToDecisions({ [ASSET]: "issuer" })).toEqual([
    { id: assetDecisionId(ASSET), choice: "return_to_issuer" },
  ]);
});

test("dispositionsToDecisions › empty dispositions → empty decisions", () => {
  expect(dispositionsToDecisions({})).toEqual([]);
});
