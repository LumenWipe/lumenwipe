import { test, expect } from "bun:test";
import { buildDemolishDecisions } from "@/lib/demolish";
import type { DecisionPoint } from "@lumenwipe/sdk";

// The real API refuses `close/transactions` outright when either half of this answer set is
// missing: an unrecognized destination is a 422 `destination_not_acknowledged` (the sink is a
// random testnet keypair, never a registry exchange, so it fires every time), and a funded
// trustline with no disposition is a 422 `needs_decisions`. These pin the exact ids and choice
// strings the API's apps/api/src/lib/close-api/decisions.ts expects.

const SINK = "GBOYVOCQNI34T7IO6RPNE6RZCVD7WNTFJZJUEX64RSQF6IJT5NFDRGMN";
const ISSUER = "GCXXGL3PVDB3EN22CP7JQYVZUVZ6IDN6URCQGPIZZ4WAPRRZTOFJMVEV";

function assetPoint(code: string): DecisionPoint {
  return {
    id: `asset:${code}-${ISSUER}`,
    type: "asset_disposition",
    subject: { kind: "trustline", asset: `${code}:${ISSUER}`, balance: "25", convertible: false },
    options: [{ id: "return_to_issuer" }, { id: "transfer_to_account" }],
    default: "return_to_issuer",
    required: true,
  };
}

test("always acknowledges the destination, keyed by the sink's own address", () => {
  const answers = buildDemolishDecisions([], SINK);
  expect(answers).toEqual([{ id: `destination:${SINK}`, choice: "i_control_this_address" }]);
});

test("answers every asset disposition with return_to_issuer, echoing the point's own id", () => {
  const answers = buildDemolishDecisions([assetPoint("LWDEMO"), assetPoint("RUGPULL")], SINK);
  expect(answers).toEqual([
    { id: `destination:${SINK}`, choice: "i_control_this_address" },
    { id: `asset:LWDEMO-${ISSUER}`, choice: "return_to_issuer" },
    { id: `asset:RUGPULL-${ISSUER}`, choice: "return_to_issuer" },
  ]);
});

test("never answers convert_to_xlm, even when the plan recommends it", () => {
  const convertible: DecisionPoint = {
    ...assetPoint("LWDEMO"),
    subject: { kind: "trustline", asset: `LWDEMO:${ISSUER}`, balance: "25", convertible: true },
    options: [{ id: "convert_to_xlm", recommended: true }, { id: "return_to_issuer" }],
    default: "convert_to_xlm",
  };
  const answers = buildDemolishDecisions([convertible], SINK);
  expect(answers.map((a) => a.choice)).not.toContain("convert_to_xlm");
  expect(answers[1]).toEqual({ id: `asset:LWDEMO-${ISSUER}`, choice: "return_to_issuer" });
});

// A guess here is a guess about whether funds are claimed or permanently forfeited. Leaving it
// unanswered turns it into the API's own `needs_decisions` 422, which names the balance.
test("leaves a claimable-balance decision unanswered rather than guessing", () => {
  const claim: DecisionPoint = {
    id: "claim:00000000abc",
    type: "claimable_balance",
    subject: { kind: "claimable_balance", balanceId: "00000000abc", asset: "native" },
    options: [{ id: "claim" }, { id: "forfeit" }],
    default: "claim",
    required: true,
  };
  const answers = buildDemolishDecisions([claim], SINK);
  expect(answers.map((a) => a.id)).not.toContain("claim:00000000abc");
});
