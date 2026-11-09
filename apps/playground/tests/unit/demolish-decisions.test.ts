import { describe, test, expect } from "bun:test";
import {
  buildDemolishDecisions,
  DemolishBlockedError,
  DemolishDecisionUnanswerableError,
  planAnswers,
} from "@/lib/demolish";
import type { PlaygroundCloseExpectation } from "@/lib/verify";
import type { DecisionPoint } from "@lumenwipe/sdk";

// The real API refuses `close/transactions` outright when either half of this answer set is
// missing: an unrecognized destination is a 422 `destination_not_acknowledged` (the sink is a
// random testnet keypair, never a registry exchange, so it fires every time), and a funded
// trustline with no disposition is a 422 `needs_decisions`. These pin the exact ids and choice
// strings the API's apps/api/src/lib/close-api/decisions.ts expects, and that every answer comes
// from the session's expectation rather than from the plan.

const SINK = "GBOYVOCQNI34T7IO6RPNE6RZCVD7WNTFJZJUEX64RSQF6IJT5NFDRGMN";
const ISSUER = "GCXXGL3PVDB3EN22CP7JQYVZUVZ6IDN6URCQGPIZZ4WAPRRZTOFJMVEV";
const RECIPIENT = "GDMIIQBWLRHBLDLTB4RJ5ZTVEYNE6CF3ZUSOOMD7ZCOD4FEX3NDBBCGN";
const STRANGER = "GBLBAKEGAULFA7MYR6KJ4JRQUFJYTKGF5BRJOCXFH4KWKYKLR5HTVSR6";

function expected(over: Partial<PlaygroundCloseExpectation> = {}): PlaygroundCloseExpectation {
  return {
    demoPublic: "GDEMO",
    sinkPublic: SINK,
    assets: [
      { code: "LWDEMO", issuer: ISSUER },
      { code: "RUGPULL", issuer: ISSUER },
      { code: "LWCOIN", issuer: ISSUER },
      { code: "LWGEM", issuer: ISSUER },
    ],
    recordedSigners: [],
    raisesThresholds: false,
    offerCount: 0,
    dataEntryCount: 0,
    transfers: [],
    conversions: [],
    claims: [],
    forfeits: [],
    sponsoredEntries: [],
    ...over,
  };
}

function assetPoint(code: string, issuer = ISSUER, convertible = false): DecisionPoint {
  return {
    id: `asset:${code}-${issuer}`,
    type: "asset_disposition",
    subject: { kind: "trustline", asset: `${code}:${issuer}`, balance: "25", convertible },
    options: convertible
      ? [{ id: "convert_to_xlm", recommended: true }, { id: "return_to_issuer" }]
      : [{ id: "return_to_issuer" }, { id: "transfer_to_account" }],
    default: convertible ? "convert_to_xlm" : "",
    required: true,
  };
}

const destinationAck = { id: `destination:${SINK}`, choice: "i_control_this_address" };

test("always acknowledges the destination, keyed by the sink's own address", () => {
  expect(buildDemolishDecisions([], expected())).toEqual({
    answers: [destinationAck],
    unanswerable: [],
  });
});

test("the destination's own confirmation point is answered, not reported as unanswerable", () => {
  const point: DecisionPoint = {
    id: `destination:${SINK}`,
    type: "confirmation",
    subject: { kind: "destination", address: SINK },
    options: [{ id: "i_control_this_address" }],
    default: "",
    required: true,
  };
  expect(buildDemolishDecisions([point], expected())).toEqual({
    answers: [destinationAck],
    unanswerable: [],
  });
});

test("an asset the session burns is returned to its issuer, echoing the point's own id", () => {
  const { answers } = buildDemolishDecisions(
    [assetPoint("LWDEMO"), assetPoint("RUGPULL")],
    expected()
  );
  expect(answers).toEqual([
    destinationAck,
    { id: `asset:LWDEMO-${ISSUER}`, choice: "return_to_issuer" },
    { id: `asset:RUGPULL-${ISSUER}`, choice: "return_to_issuer" },
  ]);
});

test("a recommended conversion is not taken unless the session chose it", () => {
  const { answers } = buildDemolishDecisions([assetPoint("LWDEMO", ISSUER, true)], expected());
  expect(answers[1]).toEqual({ id: `asset:LWDEMO-${ISSUER}`, choice: "return_to_issuer" });
});

test("an asset the session converts is answered convert_to_xlm with the session's floor", () => {
  const { answers } = buildDemolishDecisions(
    [assetPoint("LWCOIN", ISSUER, true)],
    expected({
      conversions: [{ asset: `LWCOIN:${ISSUER}`, amount: "20", minAmountOut: "99000000" }],
    })
  );
  expect(answers[1]).toEqual({
    id: `asset:LWCOIN-${ISSUER}`,
    choice: "convert_to_xlm",
    params: { minAmountOut: "99000000" },
  });
});

test("an asset the session transfers is sent to the session's recipient", () => {
  const { answers } = buildDemolishDecisions(
    [assetPoint("LWGEM")],
    expected({ transfers: [{ asset: `LWGEM:${ISSUER}`, destination: RECIPIENT, amount: "8" }] })
  );
  expect(answers[1]).toEqual({
    id: `asset:LWGEM-${ISSUER}`,
    choice: "transfer_to_account",
    params: { destination: RECIPIENT },
  });
});

test("a code the session planned, under an issuer it did not, is unanswerable", () => {
  const { answers, unanswerable } = buildDemolishDecisions(
    [assetPoint("LWDEMO", STRANGER)],
    expected()
  );
  expect(answers).toEqual([destinationAck]);
  expect(unanswerable).toEqual([`asset:LWDEMO-${STRANGER}`]);
});

// A guess here is a guess about whether funds are claimed or permanently forfeited.
test("a claimable-balance decision is reported as unanswerable rather than guessed", () => {
  const claim: DecisionPoint = {
    id: "claim:00000000abc",
    type: "claimable_balance",
    subject: { kind: "claimable_balance", balanceId: "00000000abc", asset: "native" },
    options: [{ id: "claim" }, { id: "forfeit" }],
    default: "claim",
    required: true,
  };
  const { answers, unanswerable } = buildDemolishDecisions([claim], expected());
  expect(answers.map((a) => a.id)).not.toContain("claim:00000000abc");
  expect(unanswerable).toEqual(["claim:00000000abc"]);
});

test("a required confirmation the API adds is unanswerable; an optional one is skipped", () => {
  const confirmation = (id: string, required: boolean): DecisionPoint => ({
    id,
    type: "confirmation",
    subject: { kind: "defi_positions" },
    options: [{ id: "no_defi_positions_confirmed_manually" }],
    default: "",
    required,
  });
  const { answers, unanswerable } = buildDemolishDecisions(
    [confirmation("defi_positions:GDEMO", true), confirmation("optional:GDEMO", false)],
    expected()
  );
  expect(answers).toEqual([destinationAck]);
  expect(unanswerable).toEqual(["defi_positions:GDEMO"]);
});

test("an asset point without a readable asset is unanswerable", () => {
  const point: DecisionPoint = { ...assetPoint("LWDEMO"), subject: { kind: "trustline" } };
  expect(buildDemolishDecisions([point], expected()).unanswerable).toEqual([point.id]);
});

test("a Soroban token someone dusted the demo account with is acknowledged, not 'returned to an issuer' it does not have", () => {
  const tokenPoint: DecisionPoint = {
    id: "token:CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV",
    type: "asset_disposition",
    subject: {
      kind: "soroban_token",
      contract: "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV",
    },
    options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
    default: "transfer_to_account",
    required: true,
  };
  const { answers, unanswerable } = buildDemolishDecisions(
    [assetPoint("LWDEMO"), tokenPoint],
    expected()
  );
  expect(answers).toContainEqual({ id: tokenPoint.id, choice: "acknowledge_residue" });
  expect(answers.find((a) => a.id === assetPoint("LWDEMO").id)?.choice).toBe("return_to_issuer");
  expect(unanswerable).toEqual([]);
});

test("with both tokens converted or both transferred, each answer is its own asset's", () => {
  const { answers } = buildDemolishDecisions(
    [assetPoint("LWCOIN", ISSUER, true), assetPoint("LWGEM", ISSUER, true)],
    expected({
      conversions: [
        { asset: `LWCOIN:${ISSUER}`, amount: "20", minAmountOut: "99000000" },
        { asset: `LWGEM:${ISSUER}`, amount: "8", minAmountOut: "39600000" },
      ],
    })
  );
  expect(answers.slice(1).map((a) => a.params?.minAmountOut)).toEqual(["99000000", "39600000"]);
  const other = "GOTHERRECIPIENT";
  const transferred = buildDemolishDecisions(
    [assetPoint("LWCOIN"), assetPoint("LWGEM")],
    expected({
      transfers: [
        { asset: `LWCOIN:${ISSUER}`, destination: RECIPIENT, amount: "20" },
        { asset: `LWGEM:${ISSUER}`, destination: other, amount: "8" },
      ],
    })
  );
  expect(transferred.answers.slice(1).map((a) => a.params?.destination)).toEqual([
    RECIPIENT,
    other,
  ]);
});

test("only an asset_disposition point about a trustline is answered as one", () => {
  const lookalike: DecisionPoint = { ...assetPoint("LWDEMO"), type: "confirmation" };
  const otherKind: DecisionPoint = {
    ...assetPoint("LWDEMO"),
    id: "pool:LWDEMO",
    subject: { kind: "liquidity_pool_share", asset: `LWDEMO:${ISSUER}` },
  };
  expect(buildDemolishDecisions([lookalike, otherKind], expected())).toEqual({
    answers: [destinationAck],
    unanswerable: [lookalike.id, otherKind.id],
  });
});

test("the stop names itself, so a log line reads as what it is", () => {
  const err = new DemolishDecisionUnanswerableError(["claim:1"]);
  expect([err.name, err.message, err.decisionIds]).toEqual([
    "DemolishDecisionUnanswerableError",
    "The close needs a decision the playground cannot make",
    ["claim:1"],
  ]);
});

describe("claimable balances", () => {
  const id = (fill: string) => `00000000${fill.repeat(64)}`;
  const withClaims = () =>
    expected({
      claims: [
        { id: id("1"), asset: `BONUS:${ISSUER}`, addTrustline: false },
        { id: id("2"), asset: `GIFT:${ISSUER}`, addTrustline: true },
      ],
      forfeits: [id("3")],
    });
  const claimPoint = (balanceId: string, pointId = `claim:${balanceId}`): DecisionPoint => ({
    id: pointId,
    type: "claimable_balance",
    subject: { kind: "claimable_balance", balanceId, asset: `BONUS:${ISSUER}` },
    options: [{ id: "claim" }, { id: "forfeit" }],
    default: "",
    required: true,
  });

  test("the plan is asked with the destination and every recorded balance already answered", () => {
    expect(planAnswers(withClaims())).toEqual([
      destinationAck,
      { id: `claim:${id("1")}`, choice: "claim" },
      { id: `claim:${id("2")}`, choice: "add_trustline_then_claim" },
      { id: `claim:${id("3")}`, choice: "forfeit" },
    ]);
    expect(planAnswers(expected())).toEqual([destinationAck]);
  });

  test("each recorded balance is answered by its intent; any other is unanswerable", () => {
    const points = [
      claimPoint(id("1")),
      claimPoint(id("2")),
      claimPoint(id("3")),
      claimPoint(id("9")),
    ];
    const { answers, unanswerable } = buildDemolishDecisions(points, withClaims());
    expect(answers.slice(1)).toEqual([
      { id: `claim:${id("1")}`, choice: "claim" },
      { id: `claim:${id("2")}`, choice: "add_trustline_then_claim" },
      { id: `claim:${id("3")}`, choice: "forfeit" },
    ]);
    expect(unanswerable).toEqual([`claim:${id("9")}`]);
  });

  test("a point whose id does not name its own balance is not answered", () => {
    const mismatched = claimPoint(id("1"), `claim:${id("2")}`);
    const noId: DecisionPoint = { ...claimPoint(id("1")), subject: { kind: "claimable_balance" } };
    expect(buildDemolishDecisions([mismatched, noId], withClaims()).unanswerable).toEqual([
      mismatched.id,
      noId.id,
    ]);
  });
});

test("a plan blocker stop names itself and its codes", () => {
  const err = new DemolishBlockedError(["sponsorship_unaffordable"]);
  expect([err.name, err.message, err.blockers]).toEqual([
    "DemolishBlockedError",
    "The close reported a blocker",
    ["sponsorship_unaffordable"],
  ]);
});
