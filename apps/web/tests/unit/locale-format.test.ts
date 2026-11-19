import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPostDate } from "@/lib/blog-date";
import { formatXlmDown } from "@/lib/api/estimate-client";
import { formatDate, formatList, formatNumber, plural, TWO_DECIMALS } from "@/lib/i18n/format";
import {
  localeFromHeader,
  localeOfPath,
  LOCALE_TAGS,
  LOCALES,
  SITE_LOCALE,
} from "@/lib/i18n/locale";

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

  test("a post date is the calendar day written, whatever the reader's time zone", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Bogota";
    try {
      expect(formatPostDate("en", "2026-11-15")).toBe("November 15, 2026");
    } finally {
      process.env.TZ = tz;
    }
  });

  test("post dates read as the en-US call they replace", () => {
    for (const iso of ["2026-01-01", "2026-11-15", "2026-12-31"]) {
      expect(formatPostDate("en", iso)).toBe(
        new Date(iso).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        })
      );
    }
  });

  test("short month and weekday names read as the en-US labels they replace", () => {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    months.forEach((label, month) =>
      expect(formatDate("en", Date.UTC(2026, month, 1), { month: "short", timeZone: "UTC" })).toBe(
        label
      )
    );
    const monday = Date.UTC(2024, 0, 1);
    expect(
      [0, 2, 4].map((day) =>
        formatDate("en", monday + day * 86_400_000, { weekday: "short", timeZone: "UTC" })
      )
    ).toEqual(["Mon", "Wed", "Fri"]);
  });
});

describe("sentences built from numbers and names", () => {
  test("a count takes the form its locale's plural rules pick", () => {
    const forms = { one: "elemento", other: "elementos" };
    expect(plural("es", 1, forms)).toBe("1 elemento");
    expect(plural("es", 0, forms)).toBe("0 elementos");
    expect(plural("es", 2, forms)).toBe("2 elementos");
    expect(plural("es", 1500, forms)).toBe("1,500 elementos");
  });

  test("a list joins with the locale's conjunction", () => {
    expect(formatList("es", ["Blend"])).toBe("Blend");
    expect(formatList("es", ["Blend", "Aquarius"])).toBe("Blend y Aquarius");
    expect(formatList("es", ["Blend", "Aquarius", "Iris"])).toBe("Blend, Aquarius e Iris");
  });

  test("an XLM amount is rounded down and written for the reader's locale", () => {
    expect(formatXlmDown("12345678999999")).toBe("1,234,567.89");
    expect(formatXlmDown("12345678999999", "es")).toBe("1,234,567.89");
    expect(formatXlmDown("19999999", "es")).toBe("1.99");
    expect(formatXlmDown("500000000000000000")).toBe("50,000,000,000.00");
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

describe("the locale of a request", () => {
  test("a path under /es is Spanish, matched case-sensitively as the routes are", () => {
    expect(localeOfPath("/es")).toBe("es");
    expect(localeOfPath("/es/nope")).toBe("es");
    for (const path of ["/", "/esx", "/es-419", "/ES", "/ES/nope", "/blog/es"]) {
      expect(localeOfPath(path), path).toBe("en");
    }
  });

  test("a header value names a locale only when it is one, else the site's own", () => {
    expect(localeFromHeader("es")).toBe("es");
    expect(localeFromHeader("en")).toBe("en");
    for (const value of [null, "", "ES", "es-419", "fr", "es "]) {
      expect(localeFromHeader(value), String(value)).toBe(SITE_LOCALE);
    }
  });
});
