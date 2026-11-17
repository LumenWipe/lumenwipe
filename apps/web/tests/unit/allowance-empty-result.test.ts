import { describe, expect, test } from "bun:test";
import type { AllowanceCoverage } from "@lumenwipe/types";
import { coverageNote, isConfirmedEmpty, unconfirmedSources } from "@/lib/allowances/empty-result";

const complete: AllowanceCoverage[] = [
  { source: "events", status: "ok" },
  { source: "registry", status: "ok" },
];

describe("empty allowance results", () => {
  test("every source ran to completion, so an empty list really does mean none", () => {
    expect(isConfirmedEmpty(complete)).toBe(true);
    expect(unconfirmedSources(complete)).toEqual([]);
  });

  test("a complete StellarIndex scan stands in for the two scans it replaced", () => {
    const viaIndexer: AllowanceCoverage[] = [
      { source: "indexer", status: "ok" },
      { source: "events", status: "skipped", detail: "StellarIndex answered" },
      { source: "registry", status: "skipped", detail: "StellarIndex answered" },
    ];
    expect(isConfirmedEmpty(viaIndexer)).toBe(true);
    expect(coverageNote(viaIndexer)).toBeNull();
  });

  test("a StellarIndex scan that stopped early cannot support the word none", () => {
    expect(
      unconfirmedSources([
        { source: "indexer", status: "ok", detail: "4 operation pages read; older ones were not" },
        { source: "events", status: "skipped", detail: "StellarIndex answered" },
        { source: "registry", status: "skipped", detail: "StellarIndex answered" },
      ])
    ).toEqual(["the StellarIndex scan"]);
  });

  test("a failed StellarIndex scan leaves the fallback scans to decide", () => {
    expect(
      isConfirmedEmpty([{ source: "indexer", status: "failed", detail: "timeout" }, ...complete])
    ).toBe(true);
  });

  test("a failed source means the account is unconfirmed, not clear", () => {
    expect(
      unconfirmedSources([
        { source: "events", status: "failed", detail: "getEvents unavailable" },
        { source: "registry", status: "ok" },
      ])
    ).toEqual(["the approval event scan"]);
  });

  test("a skipped source counts too - nothing was read there either", () => {
    expect(
      unconfirmedSources([
        { source: "events", status: "ok" },
        { source: "registry", status: "skipped", detail: "no known tokens for this network" },
      ])
    ).toEqual(["the known-contract scan"]);
  });

  test("an event scan that stopped short cannot support the word none", () => {
    expect(
      unconfirmedSources([
        { source: "events", status: "ok", detail: "stopped at 50 candidate pairs" },
        { source: "registry", status: "ok" },
      ])
    ).toEqual(["the approval event scan"]);
  });

  test("the known-contract sweep being partial is a footnote, not an alarm", () => {
    // That sweep is a bounded cross-product - on testnet 132 combinations against a 50-pair
    // budget - so it is always partial. Treating it as "could not confirm" would make the
    // warning state the only state, which is how a warning stops meaning anything.
    const partial: AllowanceCoverage[] = [
      { source: "events", status: "ok" },
      {
        source: "registry",
        status: "ok",
        detail: "50 of 132 known-contract combinations were probed",
      },
    ];
    expect(isConfirmedEmpty(partial)).toBe(true);
    expect(coverageNote(partial)).toBe("50 of 132 known-contract combinations were probed");
  });

  test("a complete sweep has no footnote to show", () => {
    expect(coverageNote(complete)).toBeNull();
    expect(coverageNote([{ source: "events", status: "ok" }])).toBeNull();
  });

  test("a source missing from coverage is not a source that answered", () => {
    // The test is positive evidence, not the absence of bad news: an older API build, a cached
    // body, or an error path that forgot to populate coverage must not read as all-clear.
    expect(unconfirmedSources([{ source: "events", status: "ok" }])).toEqual([
      "the known-contract scan",
    ]);
    expect(isConfirmedEmpty([])).toBe(false);
    expect(isConfirmedEmpty(undefined)).toBe(false);
    expect(unconfirmedSources(undefined)).toEqual([
      "the approval event scan",
      "the known-contract scan",
    ]);
  });
});
