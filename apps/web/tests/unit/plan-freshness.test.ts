import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { PlanResponse } from "@lumenwipe/sdk";
import {
  comparePlans,
  describeChange,
  heldToStoredFloors,
  isComparable,
  preparedAgo,
  signatureOf,
  type ComparableSignature,
  type PlanSignature,
  type SignatureAnswers,
} from "@/lib/plan/plan-freshness";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import type { PlannedStep } from "@/types/plan";
import { freshPlan } from "./fixtures/fresh-plan";
import { freshAccount } from "./fixtures/account";

const SOURCE = Keypair.random().publicKey();
const USDC = `USDC:${Keypair.random().publicKey()}`;
const TOKEN = "C" + "A".repeat(55);

function step(index: number, type: PlannedStep["type"], fee = "0.0000100"): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: fee,
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

const STEPS = [step(0, "HANDLE_ASSETS"), step(1, "MERGE")];

const NO_ANSWERS: SignatureAnswers = {
  assetDispositions: {},
  tokenConversionFloors: {},
  classicConversionFloors: {},
  claimableBalanceSelections: {},
};

const CONVERTING: SignatureAnswers = {
  ...NO_ANSWERS,
  assetDispositions: { [USDC]: "convert" },
  classicConversionFloors: { [USDC]: { minAmountOut: "30000000" } },
};

const ACCOUNT = freshAccount(SOURCE, {
  trustlines: [{ asset: USDC, balance: "5" }] as never,
});

function decision(id: string): PlanResponse["decisionPoints"][number] {
  return { id, type: "confirmation", subject: {}, options: [], default: "x", required: false };
}

/** A fresh signature the comparison may be given: every fee read, every convert floored. */
function comparable(signature: PlanSignature): ComparableSignature {
  if (!isComparable(signature)) throw new Error("not comparable");
  return signature;
}

function fresh(...args: Parameters<typeof signatureOf>): ComparableSignature {
  return comparable(signatureOf(...args));
}

const reviewed = signatureOf(freshPlan(STEPS), ACCOUNT, CONVERTING);

test("an identical plan is no change, so the consent holds", () => {
  expect(comparePlans(reviewed, fresh(freshPlan(STEPS), ACCOUNT, CONVERTING))).toEqual([]);
});

test("an extra step is a change", () => {
  const next = fresh(freshPlan([...STEPS, step(2, "CANCEL_OFFERS")]), ACCOUNT, CONVERTING);
  const changes = comparePlans(reviewed, next);
  expect(changes).toContainEqual({ kind: "step-count", before: 2, after: 3 });
  expect(changes.map(describeChange)).toContain("The plan now has 3 steps instead of 2.");
});

test("a fee change in any step is a change, even with the same number of steps", () => {
  const next = fresh(
    freshPlan([step(0, "HANDLE_ASSETS", "0.0000200"), step(1, "MERGE")]),
    ACCOUNT,
    CONVERTING
  );
  const changes = comparePlans(reviewed, next);
  expect(changes).toContainEqual({ kind: "steps" });
});

test("a lower net estimate is a change, with both figures said", () => {
  const poorer = freshAccount(SOURCE, {
    trustlines: ACCOUNT.trustlines,
    nativeBalanceLumens: "10.0000000",
  });
  const changes = comparePlans(reviewed, fresh(freshPlan(STEPS), poorer, CONVERTING));
  const net = changes.find((c) => c.kind === "net");
  expect(net).toBeDefined();
  expect(describeChange(net!)).toBe(
    "The least you will receive is now about 12.99998 XLM, where it was about 15.49998 XLM."
  );
});

test("a higher net estimate is no change: the close delivers more than was consented to", () => {
  const richer = freshAccount(SOURCE, {
    trustlines: ACCOUNT.trustlines,
    nativeBalanceLumens: "20.0000000",
  });
  expect(comparePlans(reviewed, fresh(freshPlan(STEPS), richer, CONVERTING))).toEqual([]);
});

const EXIT = "C" + "B".repeat(55);

/** A plan of one simulated exit, whose fee is under 1 XLM, and a merge. */
function exitPlan(feeStroops: string, simulated = feeStroops, title = "Exit Phoenix") {
  const exit: PlannedStep = {
    ...step(0, "EXIT_POSITIONS", `0.${feeStroops.padStart(7, "0")}`),
    title,
    affectedContract: EXIT,
  };
  const steps = [exit, step(1, "MERGE")];
  return freshPlan(steps, {
    estimate: {
      feeStroops: (BigInt(feeStroops) + BigInt(100)).toString(),
      freedReserveXlm: "1.0000000",
      feeParts: {
        classicStroops: "100",
        sorobanSimulatedStroops: simulated,
        sorobanBoundStroops: "0",
      },
    },
  });
}

const reviewedExit = signatureOf(exitPlan("4569288"), ACCOUNT, CONVERTING);

test("the fee tolerance is 1% of the simulated part of the fees", () => {
  expect(reviewedExit.feeToleranceStroops).toBe("45692");
  expect(reviewed.feeToleranceStroops).toBe("0");
});

test("a simulated fee that rose within the tolerance is no change", () => {
  for (const fee of ["4570225", "4571866", "4614980"]) {
    const next = fresh(exitPlan(fee), ACCOUNT, CONVERTING);
    expect(comparePlans(reviewedExit, next)).toEqual([]);
  }
});

test("a simulated fee that rose past the tolerance is a change of the fees and the net", () => {
  const next = fresh(exitPlan("4614981"), ACCOUNT, CONVERTING);
  const changes = comparePlans(reviewedExit, next);
  expect(changes).toContainEqual({ kind: "steps" });
  expect(changes.map((c) => c.kind)).toContain("net");
});

test("a fee that fell is never a change, however far", () => {
  const next = fresh(exitPlan("569288"), ACCOUNT, CONVERTING);
  expect(comparePlans(reviewedExit, next)).toEqual([]);
});

test("a changed step is a change even when its fee is the same", () => {
  const next = fresh(exitPlan("4569288", "4569288", "Exit Blend"), ACCOUNT, CONVERTING);
  expect(comparePlans(reviewedExit, next)).toEqual([{ kind: "steps" }]);
});

test("a net drop past the tolerance is a change even when the fees did not move", () => {
  const poorer = freshAccount(SOURCE, {
    trustlines: ACCOUNT.trustlines,
    nativeBalanceLumens: "12.4954307",
  });
  const changes = comparePlans(reviewedExit, fresh(exitPlan("4569288"), poorer, CONVERTING));
  expect(changes.map((c) => c.kind)).toEqual(["net"]);
});

test("a simulated part above the fees the user saw is held to those fees", () => {
  const inflated = signatureOf(exitPlan("4569288", "99999999999"), ACCOUNT, CONVERTING);
  expect(inflated.feeToleranceStroops).toBe("45693");
});

test("a simulated part that is not whole stroops gives no tolerance", () => {
  for (const simulated of ["4569288.5", "-1", ""]) {
    const odd = signatureOf(exitPlan("4569288", simulated), ACCOUNT, CONVERTING);
    expect(odd.feeToleranceStroops).toBe("0");
  }
});

test("a new decision point is a change", () => {
  const next = fresh(
    freshPlan(STEPS, { decisionPoints: [decision("confirm:new")] }),
    ACCOUNT,
    CONVERTING
  );
  expect(comparePlans(reviewed, next)).toEqual([{ kind: "new-decision", count: 1 }]);
});

test("a changed transaction count is a change", () => {
  const next = fresh(
    freshPlan(STEPS, {
      execution: { estimatedTransactionCount: 3, transactions: [] },
    } as Partial<PlanResponse>),
    ACCOUNT,
    CONVERTING
  );
  expect(comparePlans(reviewed, next)).toEqual([
    { kind: "transaction-count", before: 2, after: 3 },
  ]);
});

test("a quote that drifted is no change: the swap is held to the floor the user accepted", () => {
  const drifted = freshPlan(STEPS, {
    decisionPoints: [
      {
        id: `asset:${USDC}`,
        type: "asset_disposition",
        subject: {},
        options: [{ id: "convert_to_xlm", quote: { estimatedReceive: "9" } }],
        default: "convert_to_xlm",
        required: true,
      },
    ],
  } as Partial<PlanResponse>);
  const before = signatureOf(
    freshPlan(STEPS, { decisionPoints: drifted.decisionPoints }),
    ACCOUNT,
    CONVERTING
  );
  expect(comparePlans(before, fresh(drifted, ACCOUNT, CONVERTING))).toEqual([]);
});

test("a convert with no stored floor is never comparable, so no quote stands in for it", () => {
  const unfloored: SignatureAnswers = {
    ...NO_ANSWERS,
    assetDispositions: { [TOKEN]: "convert" },
  };
  const account = freshAccount(SOURCE, {
    sorobanTokens: { tokens: [{ contract: TOKEN }] } as never,
  });
  const signature = signatureOf(freshPlan(STEPS), account, unfloored);
  expect(signature.unflooredConverts).toEqual([TOKEN]);
  expect(isComparable(signature)).toBe(false);
});

test("a classic floor of null, an asset only an exit pays in, is a floor and adds nothing", () => {
  const exitPaid: SignatureAnswers = {
    ...NO_ANSWERS,
    assetDispositions: { [USDC]: "convert" },
    classicConversionFloors: { [USDC]: { minAmountOut: null } },
  };
  const signature = signatureOf(freshPlan(STEPS), ACCOUNT, exitPaid);
  expect(signature.unflooredConverts).toEqual([]);
  expect(comparePlans(signature, fresh(freshPlan(STEPS), ACCOUNT, exitPaid))).toEqual([]);
});

test("the holdings say which assets and balances the account has", () => {
  const more = freshAccount(SOURCE, {
    trustlines: [...ACCOUNT.trustlines, { asset: `EURC:${SOURCE}`, balance: "1" }] as never,
  });
  expect(signatureOf(freshPlan(STEPS), more, CONVERTING).holdings).not.toBe(reviewed.holdings);
  expect(signatureOf(freshPlan(STEPS), ACCOUNT, CONVERTING).holdings).toBe(reviewed.holdings);
});

test("a fee that cannot be read is never comparable", () => {
  const unreadable = signatureOf(freshPlan([step(0, "MERGE", "abc")]), ACCOUNT, CONVERTING);
  expect(unreadable.netStroops).toBeNull();
  expect(isComparable(unreadable)).toBe(false);
});

test("a reviewed plan whose fees could not be read says so when the fresh one can", () => {
  const unreadable = signatureOf(freshPlan([step(0, "MERGE", "abc")]), ACCOUNT, CONVERTING);
  const net = comparePlans(unreadable, fresh(freshPlan(STEPS), ACCOUNT, CONVERTING)).find(
    (c) => c.kind === "net"
  );
  expect(describeChange(net!)).toBe(
    "The least you will receive is now about 15.49998 XLM, where it was an amount that could not be estimated."
  );
});

test("the expected receive is held to the stored floors, not to a quote that rose", () => {
  const live: ExpectedReceive = {
    totalStroops: "200000000",
    balanceStroops: "125000000",
    reserveStroops: "10000000",
    feeStroops: "100",
    swapStroops: "75000100",
    claimStroops: "0",
    exitStroops: "0",
    estimated: true,
    unquotedSwaps: 0,
    flaggedSwaps: 0,
    leavesOutDefiExits: false,
    uncomputedExits: [],
  };
  const held = heldToStoredFloors(live, CONVERTING);
  expect(held.swapStroops).toBe("30000000");
  expect(held.totalStroops).toBe("154999900");
});

test("the prepared line says how old the plan is", () => {
  expect(preparedAgo(0)).toBe("Plan prepared just now");
  expect(preparedAgo(59_999)).toBe("Plan prepared just now");
  expect(preparedAgo(3 * 60_000)).toBe("Plan prepared 3 min ago");
  expect(preparedAgo(61 * 60_000)).toBe("Plan prepared over an hour ago");
  expect(preparedAgo(-5_000)).toBe("Plan prepared just now");
});

test("a step whose description changed is a change", () => {
  const described = [{ ...STEPS[0]!, description: "Return 10000 USDC to its issuer" }, STEPS[1]!];
  expect(comparePlans(reviewed, fresh(freshPlan(described), ACCOUNT, CONVERTING))).toEqual([
    { kind: "steps" },
  ]);
});

test("a holding whose amount changed keeps its identity and is a change of amounts", () => {
  const grown = freshAccount(SOURCE, { trustlines: [{ asset: USDC, balance: "5000" }] as never });
  const signature = fresh(freshPlan(STEPS), grown, CONVERTING);
  expect(signature.holdings).toBe(reviewed.holdings);
  expect(comparePlans(reviewed, signature)).toEqual([{ kind: "amounts" }]);
});

test("a claimable balance whose amount changed is a change of amounts", () => {
  const claim = (amount: string) =>
    freshAccount(SOURCE, {
      trustlines: ACCOUNT.trustlines,
      claimableBalances: [{ id: "00" + "1".repeat(62), asset: USDC, amount }] as never,
    });
  const before = signatureOf(freshPlan(STEPS), claim("1"), CONVERTING);
  expect(comparePlans(before, fresh(freshPlan(STEPS), claim("2"), CONVERTING))).toEqual([
    { kind: "amounts" },
  ]);
});

test.each([
  ["an added signer", { signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }] }],
  ["a changed threshold", { thresholds: { low: 0, med: 2, high: 0 } }],
  ["a new sponsorship", { numSponsoring: 1 }],
])("%s is a change of who may sign or what is sponsored", (_case, overrides) => {
  const changed = freshAccount(SOURCE, { trustlines: ACCOUNT.trustlines, ...overrides } as never);
  expect(comparePlans(reviewed, fresh(freshPlan(STEPS), changed, CONVERTING))).toContainEqual({
    kind: "authority",
  });
});
