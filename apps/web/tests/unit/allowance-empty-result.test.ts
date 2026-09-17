import { describe, expect, test } from "bun:test";
import type { AllowanceCoverage } from "@lumenwipe/types";
import { isConfirmedEmpty, unconfirmedSources } from "@/lib/allowances/empty-result";

const complete: AllowanceCoverage[] = [
  { source: "events", status: "ok" },
  { source: "registry", status: "ok" },
];

describe("empty allowance results", () => {
  test("every source ran to completion, so an empty list really does mean none", () => {
    expect(isConfirmedEmpty(complete)).toBe(true);
    expect(unconfirmedSources(complete)).toEqual([]);
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

  test("an ok source carrying a detail is a partial pass, which cannot support the word none", () => {
    // Both scans report partial coverage this way: the event scan when it stops at its candidate
    // cap, the registry source when its budget ran out mid cross-product.
    expect(
      unconfirmedSources([
        { source: "events", status: "ok", detail: "stopped at 50 candidate pairs" },
        { source: "registry", status: "ok" },
      ])
    ).toEqual(["the approval event scan"]);
    expect(
      isConfirmedEmpty([
        { source: "events", status: "ok" },
        { source: "registry", status: "ok", detail: "18 of 120 combinations were probed" },
      ])
    ).toBe(false);
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
