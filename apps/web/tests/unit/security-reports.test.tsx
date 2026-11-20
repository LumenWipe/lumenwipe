import { afterEach, describe, expect, mock, test } from "bun:test";
import { within } from "@testing-library/react";
import EnglishReportsPage from "@/app/(marketing)/security/reports/page";
import SpanishReportsPage from "@/app/(marketing-es)/es/security/reports/page";
import SecurityReportsPage from "@/components/marketing/SecurityReportsPage";
import { SECURITY_REPORTS } from "@/lib/i18n/messages/security-reports";
import { parseSecurityReports, securityReports, severityCounts } from "@/lib/security-reports";
import { DOCS_URL } from "@/lib/site/navigation";
import { REPO_URL } from "@/lib/site/trust";
import { renderMarketing } from "./fixtures/marketing";

const COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

/** A report as an entry in content/security-reports.json would carry it. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "web-and-api-2027",
    title: "Web app and API review",
    scope: "apps/web signing flow and the apps/api mediator",
    date: "2027-03-01",
    performedBy: "Example Reviewer",
    commit: COMMIT,
    reportUrl: "https://reports.example.test/lumenwipe-2027.pdf",
    findings: [
      { id: "F-1", title: "Forward cap off by one", severity: "high", status: "fixed" },
      { id: "F-2", title: "Verbose error text", severity: "low", status: "accepted" },
      { id: "F-3", title: "Missing header", severity: "low", status: "open" },
    ],
    ...overrides,
  };
}

afterEach(() => mock.restore());

describe("content/security-reports.json", () => {
  test("lists no report today", () => {
    expect(securityReports()).toEqual([]);
  });

  test("an entry parses into a report, newest first", () => {
    const older = entry({ id: "older", date: "2026-12-01" });
    expect(parseSecurityReports([older, entry()]).map((r) => r.id)).toEqual([
      "web-and-api-2027",
      "older",
    ]);
  });

  test("counts findings at every severity", () => {
    expect(severityCounts(parseSecurityReports([entry()])[0]!)).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 2,
      informational: 0,
    });
  });

  test.each([
    ["a report link over http", { reportUrl: "http://reports.example.test/r.pdf" }, "https"],
    ["a script link", { reportUrl: "javascript:alert(1)" }, "https"],
    ["a relative link", { reportUrl: "/r.pdf" }, "absolute URL"],
    [
      "a link with credentials",
      { reportUrl: "https://a:b@reports.example.test/r.pdf" },
      "credentials",
    ],
    ["a short commit", { commit: "89abcde" }, "commit"],
    ["a commit with a path", { commit: `${COMMIT.slice(0, 39)}/` }, "commit"],
    ["a date that is not on the calendar", { date: "2027-02-30" }, "date"],
    ["an id with a slash", { id: "a/b" }, "id"],
    ["an empty scope", { scope: " " }, "scope"],
    ["no findings list", { findings: undefined }, "findings"],
    [
      "an unknown severity",
      { findings: [{ id: "F-1", title: "t", severity: "severe", status: "fixed" }] },
      "severity",
    ],
    [
      "an unknown fix status",
      { findings: [{ id: "F-1", title: "t", severity: "low", status: "done" }] },
      "status",
    ],
  ])("refuses %s, naming the field", (_name, overrides, field) => {
    expect(() => parseSecurityReports([entry(overrides)])).toThrow(field);
  });

  test("refuses data that is not a list, an entry that is not an object, and a repeated id", () => {
    expect(() => parseSecurityReports({})).toThrow("must be a list");
    expect(() => parseSecurityReports(["report"])).toThrow("entry 0: must be an object");
    expect(() => parseSecurityReports([entry(), entry()])).toThrow("same id");
  });
});

describe("/security/reports", () => {
  for (const [locale, Page] of [
    ["en", EnglishReportsPage],
    ["es", SpanishReportsPage],
  ] as const) {
    test(`with no report, the ${locale} page links the self-assessed documents`, () => {
      const T = SECURITY_REPORTS[locale];
      const root = renderMarketing(<Page />);
      const empty = root.querySelector("[data-reports-empty]") as HTMLElement;
      expect(empty).not.toBeNull();
      expect(empty.textContent).toContain(T.empty.heading);
      expect(within(empty).getAllByText(T.empty.selfAssessed)).toHaveLength(2);
      expect(
        within(empty)
          .getByRole("link", { name: new RegExp(T.empty.documents.threatModel.title) })
          .getAttribute("href")
      ).toBe(`${DOCS_URL}/threat-model`);
      expect(
        within(empty)
          .getByRole("link", { name: new RegExp(T.empty.documents.remediationPlan.title) })
          .getAttribute("href")
      ).toBe(`${DOCS_URL}/security-remediation-plan`);
      expect(root.querySelector("[data-report]")).toBeNull();
    });
  }

  test("an entry in the data file renders every section with no code change", () => {
    const T = SECURITY_REPORTS.en;
    const root = renderMarketing(
      <SecurityReportsPage locale="en" reports={parseSecurityReports([entry()])} />
    );
    expect(root.querySelector("[data-reports-empty]")).toBeNull();
    const report = root.querySelector('[data-report="web-and-api-2027"]') as HTMLElement;
    const text = report.textContent ?? "";
    for (const value of [
      "Web app and API review",
      T.report.scope,
      "apps/web signing flow and the apps/api mediator",
      T.report.date,
      "2027-03-01",
      T.report.performedBy,
      "Example Reviewer",
      T.report.commit,
    ]) {
      expect(text).toContain(value);
    }
    expect(
      within(report)
        .getByRole("link", { name: /89abcde/ })
        .getAttribute("href")
    ).toBe(`${REPO_URL}/commit/${COMMIT}`);
    expect(
      within(report)
        .getByRole("link", { name: new RegExp(T.report.fullReport) })
        .getAttribute("href")
    ).toBe("https://reports.example.test/lumenwipe-2027.pdf");
    expect(report.querySelector('[data-severity="high"]')?.textContent).toBe("High1");
    expect(report.querySelector('[data-severity="low"]')?.textContent).toBe("Low2");
    expect(report.querySelector('[data-severity="critical"]')?.textContent).toBe("Critical0");
    expect(report.querySelector('[data-finding="F-1"]')?.textContent).toContain("Fixed");
    expect(report.querySelector('[data-finding="F-2"]')?.textContent).toContain("Accepted risk");
    expect(report.querySelector('[data-finding="F-3"]')?.textContent).toContain("Open");
  });

  test("a report with no findings says so", () => {
    const root = renderMarketing(
      <SecurityReportsPage locale="en" reports={parseSecurityReports([entry({ findings: [] })])} />
    );
    expect(root.querySelector("[data-report]")?.textContent).toContain(
      SECURITY_REPORTS.en.report.noFindings
    );
    expect(root.querySelector("[data-finding]")).toBeNull();
  });

  test("a Spanish page marks an entry's own text as English", () => {
    const root = renderMarketing(
      <SecurityReportsPage locale="es" reports={parseSecurityReports([entry()])} />
    );
    const report = root.querySelector("[data-report]") as HTMLElement;
    expect(report.querySelector("h2")?.getAttribute("lang")).toBe("en");
    expect(report.textContent).toContain(SECURITY_REPORTS.es.report.scope);
  });

  test("states no review, audit or certification that has not happened", () => {
    for (const Page of [EnglishReportsPage, SpanishReportsPage]) {
      const text = renderMarketing(<Page />).textContent ?? "";
      expect(text).not.toMatch(/audit|independ|certif|auditor/i);
    }
  });
});
