import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "@testing-library/react";
import EnglishSecurityPage from "@/app/(marketing)/security/page";
import SpanishSecurityPage from "@/app/(marketing-es)/es/security/page";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { Locale } from "@/lib/i18n/locale";
import { FOOTER } from "@/lib/i18n/messages/footer";
import { SECURITY } from "@/lib/i18n/messages/security";
import {
  FEE_EVIDENCE,
  GUARANTEE_EVIDENCE,
  repoFileUrl,
  type FeeId,
} from "@/lib/site/security-evidence";
import { featureScope, REPO_URL, SECURITY_EMAIL, SECURITY_POLICY_URL } from "@/lib/site/trust";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { renderMarketing } from "./fixtures/marketing";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SHA = "fedcba9876543210fedcba9876543210fedcba98";
const STATUS = "https://status.example.test/summary.json";
const PAGES = { en: EnglishSecurityPage, es: SpanishSecurityPage } as const;
const ENV = ["VERCEL_GIT_COMMIT_SHA", "STATUS_SOURCE_URL"] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function page(locale: Locale): HTMLElement {
  const Page = PAGES[locale];
  return renderMarketing(<Page />);
}

function feeRow(root: HTMLElement, id: FeeId): HTMLElement {
  return root.querySelector(`[data-fee="${id}"]`) as HTMLElement;
}

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
});

afterEach(() => {
  mock.restore();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

for (const locale of ["en", "es"] as const) {
  const T = SECURITY[locale];

  describe(`the ${locale} security page`, () => {
    test("links each guarantee and fee row to the files and tests behind it", () => {
      const hrefs = [...page(locale).querySelectorAll("a")].map((a) => a.getAttribute("href"));
      for (const evidence of [
        ...Object.values(GUARANTEE_EVIDENCE),
        ...Object.values(FEE_EVIDENCE),
      ]) {
        for (const path of [...evidence.code, ...evidence.tests]) {
          expect(hrefs).toContain(repoFileUrl(path));
        }
      }
    });

    test("states every fee figure from the constant the code charges", () => {
      const root = page(locale);
      const base = String(BASE_FEE_STROOPS);
      expect(feeRow(root, "network").textContent).toContain(
        T.fees.network(base, stroopsToXlm(base))
      );
      expect(feeRow(root, "relay").textContent).toContain(
        T.fees.relay(String(2 * BASE_FEE_STROOPS))
      );
      expect(feeRow(root, "relay").textContent).toContain(featureScope("exchange-close", locale));
      expect(feeRow(root, "sponsored").textContent).toContain(
        featureScope("sponsored-fees", locale)
      );
      expect(feeRow(root, "service").textContent).toContain(T.fees.service);
      expect(feeRow(root, "conversion").textContent).toContain(T.fees.conversion);
    });

    test("with a deployed commit, links it; without one, says the build carries none", () => {
      process.env.VERCEL_GIT_COMMIT_SHA = SHA;
      const link = within(page(locale)).getByRole("link", { name: /fedcba9/ });
      expect(link.getAttribute("href")).toBe(`${REPO_URL}/commit/${SHA}`);
      mock.restore();

      delete process.env.VERCEL_GIT_COMMIT_SHA;
      const root = page(locale);
      expect(root.textContent).toContain(T.build.unknown);
      expect(root.querySelector(`a[href^="${REPO_URL}/commit/"]`)).toBeNull();
      expect(root.textContent).toContain(T.build.untagged);
    });

    test("gives the disclosure contact, the policy and security.txt", () => {
      const root = page(locale);
      expect(root.querySelector(`a[href="mailto:${SECURITY_EMAIL}"]`)).not.toBeNull();
      expect(root.querySelector(`a[href="${SECURITY_POLICY_URL}"]`)).not.toBeNull();
      expect(root.querySelector('a[href="/.well-known/security.txt"]')).not.toBeNull();
    });

    test("links the security reports page in its own language", () => {
      const href = locale === "en" ? "/security/reports" : "/es/security/reports";
      expect(
        within(page(locale)).getByRole("link", { name: T.reports.link }).getAttribute("href")
      ).toBe(href);
    });

    test("links the status page only when a status source is configured", () => {
      expect(
        within(page(locale)).queryByRole("link", { name: new RegExp(T.statusLink) })
      ).toBeNull();
      mock.restore();
      process.env.STATUS_SOURCE_URL = STATUS;
      const link = within(page(locale)).getByRole("link", { name: new RegExp(T.statusLink) });
      expect(link.getAttribute("href")).toBe("https://status.example.test");
    });

    test("states no review, audit or certification that has not happened", () => {
      const root = page(locale);
      root.querySelectorAll("[data-evidence]").forEach((el) => el.remove());
      expect(root.textContent ?? "").not.toMatch(/audit|independ|certif/i);
    });
  });

  describe(`the ${locale} footer`, () => {
    const L = FOOTER[locale].links;
    const footer = () => renderMarketing(<MarketingFooter locale={locale} />);

    test("links the security reports page", () => {
      const href = locale === "en" ? "/security/reports" : "/es/security/reports";
      expect(
        within(footer()).getByRole("link", { name: L.securityReports }).getAttribute("href")
      ).toBe(href);
    });

    test("links the status page only when a status source is configured", () => {
      expect(within(footer()).queryByRole("link", { name: L.statusPage })).toBeNull();
      mock.restore();
      process.env.STATUS_SOURCE_URL = STATUS;
      expect(within(footer()).getByRole("link", { name: L.statusPage }).getAttribute("href")).toBe(
        "https://status.example.test"
      );
    });

    test("links the deployed commit only when the build has one", () => {
      expect(footer().querySelector(`a[href^="${REPO_URL}/commit/"]`)).toBeNull();
      mock.restore();
      process.env.VERCEL_GIT_COMMIT_SHA = SHA;
      const link = footer().querySelector(`a[href="${REPO_URL}/commit/${SHA}"]`);
      expect(link?.textContent).toBe("fedcba9");
    });
  });
}

describe("the fee table matches the code it cites", () => {
  test("the API builds at the same base fee per operation the page states", () => {
    expect(read("apps/api/src/config/constants.ts")).toContain(
      `export const BASE_FEE_STROOPS = ${BASE_FEE_STROOPS}; // per operation`
    );
  });

  test("the relay's forward is the balance less its two operations' fee", () => {
    expect(read("apps/api/src/lib/stellar/tx-builder/merge.ts")).toContain(
      "BigInt(xlmToStroops(nativeBalanceLumens)) - BigInt(2 * BASE_FEE_STROOPS)"
    );
  });

  test("no service fee: the browser refuses an operation it cannot describe (INV-03)", () => {
    const tests = read("apps/web/tests/unit/verify.test.ts");
    expect(tests).toContain(
      'test("fails closed on an operation type the switch does not recognize at all"'
    );
    expect(tests).toContain('test("rejects a real transaction carrying an unrecognized operation"');
    expect(read("docs/invariants.mdx")).toMatch(/\| INV-03 .*verify\.ts#assertCloseIntent/);
  });

  test("a conversion naming a fee partner is refused by the browser and the API", () => {
    expect(read("apps/web/tests/unit/verify.test.ts")).toContain(
      'test("rejects an aggregator swap that names a fee partner"'
    );
    expect(read("apps/api/src/lib/close-api/token-conversion-round.ts")).toContain(
      'throw new Error("the swap names a fee partner")'
    );
  });

  test("a sponsored transaction carries no fee of its own", () => {
    expect(read("apps/api/src/common/error-code-descriptions.ts")).toContain(
      "The inner transaction of a sponsored fee bump must carry no fee of its own."
    );
  });
});
