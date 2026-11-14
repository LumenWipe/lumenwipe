import { describe, expect, test } from "bun:test";
import { isPassing, parseAllowlist, type AllowlistEntry } from "./audit-gate";
import { evaluateReport, parseGrypeReport } from "./image-scan-gate";

const match = (severity: string, id = "CVE-2026-0001", name = "libc6", fixState = "not-fixed") => ({
  vulnerability: {
    id,
    severity,
    fix: { state: fixState, versions: fixState === "fixed" ? ["2.41-13"] : [] },
  },
  artifact: { name, version: "2.41-12", type: "deb" },
});

const report = (...matches: unknown[]): string =>
  JSON.stringify({ matches, distro: { name: "debian", version: "13" } });

const entry = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  advisory: "CVE-2026-0001",
  package: "libc6",
  severity: "high",
  reason: "no fixed version in Debian 13 yet",
  added: "2026-11-01",
  expires: "2027-01-15",
  ...over,
});

describe("image scan gate", () => {
  test("fails on a high or critical finding that is not allowlisted", () => {
    for (const severity of ["High", "Critical"]) {
      const verdict = evaluateReport(report(match(severity)), [], "2026-11-14");
      expect(verdict.failures).toHaveLength(1);
      expect(isPassing(verdict)).toBe(false);
    }
  });

  test("a fixed and an unfixed high finding both block", () => {
    const verdict = evaluateReport(
      report(match("High", "CVE-2026-0001"), match("High", "CVE-2026-0002", "libc6", "fixed")),
      [],
      "2026-11-14"
    );
    expect(verdict.failures.map((f) => f.advisory)).toEqual(["CVE-2026-0001", "CVE-2026-0002"]);
    expect(verdict.failures[1].title).toContain("fixed in 2.41-13");
  });

  test("medium, low, negligible and unknown findings are reported and do not block", () => {
    const verdict = evaluateReport(
      report(
        match("Medium", "CVE-1"),
        match("Low", "CVE-2"),
        match("Negligible", "CVE-3"),
        match("Unknown", "CVE-4")
      ),
      [],
      "2026-11-14"
    );
    expect(verdict.informational).toHaveLength(4);
    expect(isPassing(verdict)).toBe(true);
  });

  test("a live allowlist entry passes its own finding only", () => {
    const verdict = evaluateReport(report(match("High")), [entry()], "2026-11-14");
    expect(verdict.allowed).toHaveLength(1);
    expect(isPassing(verdict)).toBe(true);

    const other = evaluateReport(
      report(match("High"), match("High", "CVE-2026-0001", "libc-bin")),
      [entry()],
      "2026-11-14"
    );
    expect(other.failures.map((f) => f.package)).toEqual(["libc-bin"]);
  });

  test("fails once the allowlist entry has expired", () => {
    const verdict = evaluateReport(report(match("High")), [entry()], "2027-01-16");
    expect(verdict.expired).toHaveLength(1);
    expect(verdict.failures).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("fails on a stale entry whose finding is gone", () => {
    const verdict = evaluateReport(report(), [entry()], "2026-11-14");
    expect(verdict.stale).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("rejects an entry with an expiry beyond the 92-day review window", () => {
    const verdict = evaluateReport(
      report(match("High")),
      [entry({ added: "2026-11-01", expires: "2027-02-02" })],
      "2026-11-14"
    );
    expect(verdict.invalid).toHaveLength(1);
    expect(isPassing(verdict)).toBe(false);
  });

  test("an allowlist entry without a reason is rejected", () => {
    const { reason: _, ...noReason } = entry();
    expect(() => parseAllowlist(JSON.stringify([noReason]))).toThrow('missing "reason"');
  });

  test("the same package and advisory matched twice counts once", () => {
    expect(parseGrypeReport(report(match("High"), match("High")))).toHaveLength(1);
  });

  test("a report with no distro is refused instead of passing empty", () => {
    expect(() => parseGrypeReport(JSON.stringify({ matches: [] }))).toThrow("no distro");
  });

  test("unusable reports throw instead of passing", () => {
    expect(() => parseGrypeReport("not json")).toThrow("not JSON");
    expect(() => parseGrypeReport(JSON.stringify({ distro: { name: "debian" } }))).toThrow(
      "no matches list"
    );
    expect(() => parseGrypeReport(report(match("Severe")))).toThrow("unexpected shape");
    expect(() => parseGrypeReport(report({ vulnerability: { id: "x" } }))).toThrow(
      "unexpected shape"
    );
  });

  test("the committed allowlist parses", async () => {
    const raw = await Bun.file(new URL("./image-scan-allowlist.json", import.meta.url)).text();
    expect(() => parseAllowlist(raw)).not.toThrow();
  });
});
