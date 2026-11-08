import { expect, test } from "bun:test";
import {
  chipLabel,
  groupChip,
  newlyOpenGroup,
  openSummary,
  proceedReasons,
  reasonsSummary,
  type DestinationFact,
  type MemoFact,
  type OpenItem,
  type ProceedFacts,
} from "@/lib/plan/open-items";

const ASSET: OpenItem = { id: "asset:A", kind: "asset", group: "HANDLE_ASSETS" };
const CLAIM: OpenItem = { id: "claim:1", kind: "claim", group: "CLAIM_BALANCES" };
const CONFIRM: OpenItem = { id: "confirm:defi", kind: "confirmation", group: null };

const READY: ProceedFacts = {
  replanning: false,
  planStale: false,
  otherHardBlockers: 0,
  assetCardsWithheld: false,
  openItems: [],
  destination: "ok",
  registryStale: false,
  registryMemoTypeDisputed: false,
  memo: "ok",
  destinationUnacknowledged: false,
};

const texts = (facts: Partial<ProceedFacts>): string[] =>
  proceedReasons({ ...READY, ...facts }).map((r) => r.text);

test("each group chip state reads as text", () => {
  expect(chipLabel(groupChip(2))).toBe("Needs your answer (2)");
  expect(chipLabel(groupChip(0))).toBe("Done");
  expect(chipLabel(groupChip(null))).toBe("Informational");
});

test("nothing is listed when everything is ready", () => {
  expect(proceedReasons(READY)).toEqual([]);
});

for (const [facts, expected] of [
  [{ replanning: true }, ["The plan is being updated"]],
  [{ planStale: true }, ["The plan below may not reflect your last answer"]],
  [{ otherHardBlockers: 1 }, ["Resolve the blocker above"]],
  [{ otherHardBlockers: 3 }, ["Resolve the 3 blockers above"]],
  [
    { assetCardsWithheld: true },
    ["The plan for this account's assets could not be loaded. Refresh to try again"],
  ],
  [{ openItems: [ASSET, ASSET, CLAIM] }, ["Open: 2 assets, 1 claimable balance"]],
  [{ openItems: [CONFIRM, CLAIM, CLAIM] }, ["Open: 2 claimable balances, 1 confirmation"]],
  [{ destination: "empty" }, ["Enter a destination"]],
  [{ destination: "invalid" }, ["Enter a valid Stellar address as the destination"]],
  [{ destination: "self" }, ["The destination cannot be the account being closed"]],
  [
    { registryStale: true },
    ["This exchange's deposit rules have expired, so it cannot be used as the destination"],
  ],
  [
    { registryMemoTypeDisputed: true },
    [
      "This exchange's memo rules could not be confirmed right now. Try again later or choose another destination",
    ],
  ],
  [
    { registryStale: true, registryMemoTypeDisputed: true },
    ["This exchange's deposit rules have expired, so it cannot be used as the destination"],
  ],
  [{ memo: "type-unchosen" }, ["Choose the memo type this exchange asks for"]],
  [
    { memo: "type-mismatch" },
    ["The memo type you chose does not match this exchange's deposit rules"],
  ],
  [{ memo: "missing" }, ["Memo is required by this exchange"]],
  [{ memo: "invalid" }, ["The memo is not valid"]],
  [{ destinationUnacknowledged: true }, ["Confirm the destination is a wallet you control"]],
] as const) {
  test(`reasons for ${JSON.stringify(facts)}`, () => {
    expect(texts(facts)).toEqual([...expected]);
  });
}

test("the open reason jumps to the first open item and opens its group", () => {
  const [open] = proceedReasons({ ...READY, openItems: [CLAIM, ASSET] });
  expect(open.target).toEqual({ selector: '[data-open-item="claim:1"]', group: "CLAIM_BALANCES" });
});

test("a memo type reason jumps to the memo type choice", () => {
  for (const memo of ["type-unchosen", "type-mismatch"] as const) {
    expect(proceedReasons({ ...READY, memo })[0].target).toEqual({
      selector: '[data-jump="destination-memo-type"]',
      group: null,
    });
  }
});

test("a destination reason links to the field even while decisions are open", () => {
  expect(proceedReasons({ ...READY, destination: "empty", openItems: [ASSET] })[1].target).toEqual({
    selector: "#plan-destination input",
    group: null,
  });
  expect(proceedReasons({ ...READY, destination: "empty" })[0].target).toEqual({
    selector: "#plan-destination input",
    group: null,
  });
});

// The button is enabled exactly when the list is empty. Every combination of every fact the
// button depends on, against the gate PlanView had before the list existed: no fact can be
// added to the gate without a reason the user can read, or listed without blocking.
test("the reasons are empty exactly when the old gate passes, over every combination", () => {
  const bools = [false, true];
  const destinations: DestinationFact[] = ["empty", "invalid", "self", "ok"];
  const memos: MemoFact[] = ["ok", "missing", "invalid", "type-unchosen", "type-mismatch"];
  const items: OpenItem[][] = [[], [ASSET], [CONFIRM, CLAIM, ASSET]];
  let combinations = 0;
  for (const replanning of bools)
    for (const otherHardBlockers of [0, 1, 2])
      for (const assetCardsWithheld of bools)
        for (const openItems of items)
          for (const destination of destinations)
            for (const registryStale of bools)
              for (const memo of memos)
                for (const destinationUnacknowledged of bools) {
                  const facts: ProceedFacts = {
                    replanning,
                    planStale: false,
                    otherHardBlockers,
                    assetCardsWithheld,
                    openItems,
                    destination,
                    registryStale,
                    registryMemoTypeDisputed: false,
                    memo,
                    destinationUnacknowledged,
                  };
                  const destinationStepReady =
                    !assetCardsWithheld && openItems.length === 0 && otherHardBlockers === 0;
                  const oldGate =
                    !replanning &&
                    destinationStepReady &&
                    destination === "ok" &&
                    !registryStale &&
                    memo === "ok" &&
                    !destinationUnacknowledged;
                  const reasons = proceedReasons(facts);
                  expect(reasons.length === 0).toBe(oldGate);
                  expect(new Set(reasons.map((r) => r.key)).size).toBe(reasons.length);
                  combinations++;
                }
  expect(combinations).toBe(2880);
});

test("the live summary counts what is left and never counts a re-plan", () => {
  expect(reasonsSummary(proceedReasons(READY))).toBe("Ready to review the full plan");
  expect(reasonsSummary(proceedReasons({ ...READY, replanning: true }))).toBe(
    "Ready to review the full plan"
  );
  expect(reasonsSummary(proceedReasons({ ...READY, destination: "empty", memo: "missing" }))).toBe(
    "2 things left before you can review the plan"
  );
  expect(reasonsSummary(proceedReasons({ ...READY, openItems: [ASSET] }))).toBe(
    "1 thing left before you can review the plan"
  );
});

test("open summary names each kind once, in a fixed order", () => {
  expect(openSummary([CLAIM, ASSET, CONFIRM, ASSET])).toBe(
    "2 assets, 1 claimable balance, 1 confirmation"
  );
});

test("the first group opens on load, then only for an item not seen before", () => {
  expect(newlyOpenGroup(null, [CONFIRM, CLAIM, ASSET])).toBe("CLAIM_BALANCES");
  expect(newlyOpenGroup(null, [])).toBeNull();
  const seen = new Set([CLAIM.id]);
  expect(newlyOpenGroup(seen, [CLAIM])).toBeNull();
  expect(newlyOpenGroup(seen, [CLAIM, ASSET])).toBe("HANDLE_ASSETS");
  expect(newlyOpenGroup(new Set<string>(), [CONFIRM])).toBeNull();
});

// An asset left open because its swap has no quote: the review would refuse it with "no minimum
// amount recorded", so analyze names it instead of folding it into the count.
const UNQUOTED: OpenItem = {
  id: "asset:NOQ:G1",
  kind: "asset",
  group: "HANDLE_ASSETS",
  unquoted: "NOQ",
};
const UNQUOTED_TEXT =
  "No swap quote is available for NOQ, so it cannot be swapped in this close. Choose another answer for it, or refresh the plan";

test("a convert with no quote is a reason of its own that names the asset", () => {
  const reasons = proceedReasons({ ...READY, openItems: [UNQUOTED] });
  expect(reasons).toEqual([
    {
      key: "unquoted:asset:NOQ:G1",
      text: UNQUOTED_TEXT,
      target: { selector: '[data-open-item="asset:NOQ:G1"]', group: "HANDLE_ASSETS" },
    },
  ]);
});

test("an asset with no quote is counted once: named, and left out of the open count", () => {
  const reasons = proceedReasons({ ...READY, openItems: [UNQUOTED, ASSET, CLAIM] });
  expect(reasons.map((r) => r.text)).toEqual(["Open: 1 asset, 1 claimable balance", UNQUOTED_TEXT]);
  // The open reason jumps to the first item it counts, not to the named one.
  expect(reasons[0].target).toEqual({
    selector: '[data-open-item="asset:A"]',
    group: "HANDLE_ASSETS",
  });
  expect(reasonsSummary(reasons)).toBe("2 things left before you can review the plan");
  expect(reasonsSummary(proceedReasons({ ...READY, openItems: [UNQUOTED] }))).toBe(
    "1 thing left before you can review the plan"
  );
});

test("each asset with no quote gets its own named reason, before the destination's", () => {
  const second: OpenItem = { ...UNQUOTED, id: "asset:ZZZ:G2", unquoted: "ZZZ" };
  expect(
    proceedReasons({ ...READY, openItems: [UNQUOTED, second], destination: "empty" }).map(
      (r) => r.key
    )
  ).toEqual(["unquoted:asset:NOQ:G1", "unquoted:asset:ZZZ:G2", "destination"]);
});
