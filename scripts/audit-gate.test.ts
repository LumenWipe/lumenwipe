import { describe, expect, test } from "bun:test";
import {
  evaluate,
  isPassing,
  parseAllowlist,
  parseReport,
  type AllowlistEntry,
  type AuditReport,
} from "./audit-gate";

const advisory = (severity: string, ghsa: string): Record<string, unknown> => ({
  id: 1,
  url: `https://github.com/advisories/${ghsa}`,
  title: "t",
  severity,
  vulnerable_versions: "<1.0.0",
});

const entry = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  advisory: "GHSA-aaaa-aaaa-aaaa",
  package: "pkg",
  severity: "high",
  reason: "no fix",
  added: "2026-10-01",
  expires: "2026-12-01",
  ...over,
});

const report = (severity: string, ghsa = "GHSA-aaaa-aaaa-aaaa"): AuditReport =>
  parseReport(JSON.stringify({ pkg: [advisory(severity, ghsa)] }));

describe("audit gate", () => {
  test("fails on a high or critical advisory that is not allowlisted", () => {
    for (const severity of ["high", "critical"]) {
      const verdict = evaluate(report(severity), [], "2026-10-10");
      expect(verdict.failures).toHaveLength(1);
      expect(isPassing(verdict)).toBe(false);
    }
  });

  test("passes on moderate and low advisories and reports them", () => {
    for (const severity of ["moderate", "low"]) {
      const verdict = evaluate(report(severity), [], "2026-10-10");
      expect(verdict.informational).toHaveLength(1);
      expect(isPassing(verdict)).toBe(true);
    }
  });

  test("passes a blocking advisory while its allowlist entry is live", () => {
    const verdict = evaluate(report("high"), [entry()], "2026-10-10");
    expect(verdict.allowed).toHaveLength(1);
    expect(isPassing(verdict)).toBe(true);
  });

  test("fails once the allowlist entry has expired", () => {
    const verdict = evaluate(report("high"), [entry()], "2026-12-02");
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.expired).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("an entry matches only its own package and advisory", () => {
    const verdict = evaluate(report("high", "GHSA-bbbb-bbbb-bbbb"), [entry()], "2026-10-10");
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.stale).toHaveLength(1);
  });

  test("fails on a stale entry whose advisory no longer appears", () => {
    const verdict = evaluate({}, [entry()], "2026-10-10");
    expect(verdict.stale).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("rejects an entry with an expiry longer than the review window", () => {
    const verdict = evaluate(report("high"), [entry({ expires: "2027-06-01" })], "2026-10-10");
    expect(verdict.invalid).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("an empty report passes", () => {
    expect(isPassing(evaluate({}, [], "2026-10-10"))).toBe(true);
  });

  test("unusable audit output throws instead of passing", () => {
    expect(() => parseReport("")).toThrow();
    expect(() => parseReport("{not json")).toThrow();
    expect(() => parseReport('{"pkg": [{"severity": "high"}]}')).toThrow();
  });

  test("the banner line before the JSON document is ignored", () => {
    expect(parseReport(`bun audit v1\n${JSON.stringify({ pkg: [] })}`)).toEqual({ pkg: [] });
  });

  test("an allowlist entry missing a field is rejected", () => {
    expect(() => parseAllowlist(JSON.stringify([{ advisory: "GHSA-x" }]))).toThrow();
  });
});
