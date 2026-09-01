import { test, expect } from "bun:test";
import { operationThresholdCategory, requiredSignatureWeight } from "@/lib/stellar/thresholds";
import type { IntentOperation, IntentOperationBody } from "@/types/close-api";
import type { AccountThresholds } from "@/types/account";

const thresholds: AccountThresholds = { low: 1, med: 2, high: 3 };

// Threshold category depends only on the operation type, so the account each op acts as is
// irrelevant here - a constant keeps these fixtures about the thing under test.
const SRC = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const op = (o: IntentOperationBody): IntentOperation => ({ ...o, source: SRC });

test("operationThresholdCategory › manage_data is medium", () => {
  expect(operationThresholdCategory(op({ type: "manage_data", name: "k", value: null }))).toBe(
    "med"
  );
});

test("operationThresholdCategory › claim_claimable_balance is low", () => {
  expect(operationThresholdCategory(op({ type: "claim_claimable_balance", balanceId: "b1" }))).toBe(
    "low"
  );
});

test("operationThresholdCategory › account_merge is high", () => {
  expect(operationThresholdCategory(op({ type: "account_merge", destination: "G..." }))).toBe(
    "high"
  );
});

test("operationThresholdCategory › payment/change_trust/revoke_sponsorship are medium", () => {
  expect(
    operationThresholdCategory(
      op({
        type: "payment",
        destination: "G...",
        asset: "native",
        amount: "1",
      })
    )
  ).toBe("med");
  expect(
    operationThresholdCategory(op({ type: "change_trust", asset: "USD:G...", limit: "0" }))
  ).toBe("med");
  expect(
    operationThresholdCategory(
      op({
        type: "revoke_sponsorship",
        entryKind: "trustline",
        owner: "G...",
      })
    )
  ).toBe("med");
});

test("operationThresholdCategory › set_options touching a signer is high", () => {
  expect(
    operationThresholdCategory(
      op({
        type: "set_options",
        signer: { type: "ed25519_public_key", key: "G...", weight: 0 },
        masterWeight: null,
        lowThreshold: null,
        medThreshold: null,
        highThreshold: null,
        homeDomain: null,
        setFlags: null,
        clearFlags: null,
        inflationDest: null,
      })
    )
  ).toBe("high");
});

test("operationThresholdCategory › set_options touching only thresholds is high", () => {
  expect(
    operationThresholdCategory(
      op({
        type: "set_options",
        signer: null,
        masterWeight: null,
        lowThreshold: 1,
        medThreshold: null,
        highThreshold: null,
        homeDomain: null,
        setFlags: null,
        clearFlags: null,
        inflationDest: null,
      })
    )
  ).toBe("high");
});

test("operationThresholdCategory › set_options touching neither signer nor thresholds is medium", () => {
  expect(
    operationThresholdCategory(
      op({
        type: "set_options",
        signer: null,
        masterWeight: null,
        lowThreshold: null,
        medThreshold: null,
        highThreshold: null,
        homeDomain: null,
        setFlags: null,
        clearFlags: null,
        inflationDest: null,
      })
    )
  ).toBe("med");
});

test("operationThresholdCategory › unknown fails closed to high", () => {
  expect(operationThresholdCategory(op({ type: "unknown" }))).toBe("high");
});

test("requiredSignatureWeight › medium-only operations require thresholds.med", () => {
  const ops: IntentOperation[] = [
    op({ type: "payment", destination: "G...", asset: "native", amount: "1" }),
    op({ type: "change_trust", asset: "USD:G...", limit: "0" }),
  ];
  expect(requiredSignatureWeight(ops, thresholds)).toBe(thresholds.med);
});

test("requiredSignatureWeight › account_merge alone requires thresholds.high", () => {
  const ops: IntentOperation[] = [op({ type: "account_merge", destination: "G..." })];
  expect(requiredSignatureWeight(ops, thresholds)).toBe(thresholds.high);
});

test("requiredSignatureWeight › a mixed set requires the max across operations", () => {
  const ops: IntentOperation[] = [
    op({ type: "claim_claimable_balance", balanceId: "b1" }), // low
    op({ type: "payment", destination: "G...", asset: "native", amount: "1" }), // med
    op({ type: "account_merge", destination: "G..." }), // high
  ];
  expect(requiredSignatureWeight(ops, thresholds)).toBe(thresholds.high);
});
