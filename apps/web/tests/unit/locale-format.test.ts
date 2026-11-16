import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDate, formatNumber, TWO_DECIMALS } from "@/lib/i18n/format";
import { LOCALE_TAGS, LOCALES, SITE_LOCALE } from "@/lib/i18n/locale";

describe("locale-aware formatting", () => {
  test("numbers read as the en-US calls they replace", () => {
    for (const n of [0, 0.5, 5, 1234.5, 1_000_000]) {
      expect(formatNumber("en", n)).toBe(n.toLocaleString("en-US"));
      expect(formatNumber("en", n, TWO_DECIMALS)).toBe(
        n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      );
    }
    expect(formatNumber("en", 5, TWO_DECIMALS)).toBe((5).toFixed(2));
  });

  test("dates and times read as the en-US calls they replace", () => {
    const iso = "2026-11-14T00:00:00Z";
    expect(formatDate("en", iso, { month: "short", year: "numeric", timeZone: "UTC" })).toBe(
      "Nov 2026"
    );
    expect(
      formatDate("en", iso, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    ).toBe("November 14, 2026");
    const readAt = "2026-11-14T14:05:00Z";
    expect(formatDate("en", readAt, { hour: "2-digit", minute: "2-digit" })).toBe(
      new Date(readAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    );
  });
});

describe("the document language", () => {
  test("every locale names its html, Intl and Open Graph tags", () => {
    expect(LOCALES).toContain(SITE_LOCALE);
    for (const locale of LOCALES) {
      expect(LOCALE_TAGS[locale].html).toMatch(/^[a-z]{2}(?:-[A-Z0-9]+)?$/);
      expect(Intl.getCanonicalLocales(LOCALE_TAGS[locale].intl)).toEqual([
        LOCALE_TAGS[locale].intl,
      ]);
      expect(LOCALE_TAGS[locale].openGraph).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
    }
  });

  // The root document loads next/font, which runs only inside a Next build, so its source is read.
  test("the html lang comes from the locale passed to the root document", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "app", "root-document.tsx"),
      "utf8"
    );
    expect(source).toContain("<html lang={LOCALE_TAGS[locale].html}");
    expect(source).not.toMatch(/lang="/);
  });
});
