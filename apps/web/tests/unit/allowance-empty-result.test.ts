import { describe, expect, test } from "bun:test";
import type { AllowanceCoverage } from "@lumenwipe/types";
import { isConfirmedEmpty, unconfirmedSources } from "@/lib/allowances/empty-result";

const ok: AllowanceCoverage[] = [
  { source: "events", status: "ok" },
  { source: "registry", status: "ok" },
];

describe("empty allowance results", () => {
  test("every source answered, so an empty list really does mean none", () => {
    expect(isConfirmedEmpty(ok)).toBe(true);
    expect(unconfirmedSources(ok)).toEqual([]);
  });

  test("a failed source means the account is unconfirmed, not clear", () => {
    const coverage: AllowanceCoverage[] = [
      { source: "events", status: "failed", detail: "getEvents unavailable" },
      { source: "registry", status: "ok" },
    ];
    expect(isConfirmedEmpty(coverage)).toBe(false);
    expect(unconfirmedSources(coverage)).toEqual(["the approval event scan"]);
  });

  test("a skipped source counts too - nothing was read there either", () => {
    const coverage: AllowanceCoverage[] = [
      { source: "events", status: "ok" },
      { source: "registry", status: "skipped", detail: "no known tokens for this network" },
    ];
    expect(isConfirmedEmpty(coverage)).toBe(false);
    expect(unconfirmedSources(coverage)).toEqual(["the known-contract scan"]);
  });

  test("both down: every source is named, so the message can say which", () => {
    const coverage: AllowanceCoverage[] = [
      { source: "events", status: "failed" },
      { source: "registry", status: "skipped" },
    ];
    expect(unconfirmedSources(coverage)).toEqual([
      "the approval event scan",
      "the known-contract scan",
    ]);
  });
});
