import { expect, test } from "bun:test";
import {
  CLOSE_FEE_PER_OPERATION_STROOPS,
  MAX_SOROBAN_FEE_STROOPS,
  MAX_SPONSORED_FEE_STROOPS,
} from "@/lib/fee-policy";
import policy from "../fixtures/api-fee-policy.json";

// The fixture is the API's own sponsor policy (apps/api/tests/unit/playground-fee-policy.test.ts),
// so the playground's copies cannot drift from it.

test("the sponsored fee ceiling is the API sponsor's own cap", () => {
  expect(MAX_SPONSORED_FEE_STROOPS).toBe(BigInt(policy.maxFeeBumpStroops));
});

test("the close fee per operation is the API's base fee", () => {
  expect(CLOSE_FEE_PER_OPERATION_STROOPS).toBe(BigInt(policy.baseFeeStroops));
});

test("the Soroban fee cap is the API's own cap on a Soroban exit", () => {
  expect(MAX_SOROBAN_FEE_STROOPS).toBe(BigInt(policy.maxSorobanExitFeeStroops));
});
