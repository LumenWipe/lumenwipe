import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { ADDRESS } from "@/lib/i18n/messages/address";
import { COMMON } from "@/lib/i18n/messages/common";
import { FAQ, type FaqFacts } from "@/lib/i18n/messages/faq";
import { FOOTER } from "@/lib/i18n/messages/footer";
import { HERO } from "@/lib/i18n/messages/hero";
import { LANDING } from "@/lib/i18n/messages/landing";
import { NAV } from "@/lib/i18n/messages/nav";
import { NOT_FOUND } from "@/lib/i18n/messages/not-found";
import { SITE } from "@/lib/i18n/messages/site";
import { nodeText } from "@/lib/site/node-text";

// The sections the navigation, footer, 404, landing and FAQ pages read, and what the landing's own
// components read (the hero, the registry sentences, the trust statements, the reserve figures).
const SECTIONS: Record<string, { en: unknown; es: unknown }> = {
  address: ADDRESS,
  common: COMMON,
  faq: FAQ,
  footer: FOOTER,
  hero: HERO,
  landing: LANDING,
  nav: NAV,
  "not-found": NOT_FOUND,
  site: SITE,
};

// Values a Spanish reader sees in English on purpose: brand and product names, and protocol terms
// and loanwords that wallets, explorers and the Stellar docs show in English
// (docs/contributing/localization.mdx).
const SAME_IN_SPANISH = new Set([
  "GitHub",
  "LumenWipe",
  "Stellar",
  "Soroban",
  "XLM",
  "Lumens",
  "DeFi",
  "trustline",
  "blockchain",
  "Blog",
  "Playground",
  "data entry",
  "data entries",
  "signer",
  "signers",
  "trustlines",
]);

/** Whether `value` holds nothing but those names, numbers and separators. */
function onlyNames(value: string): boolean {
  const names = [...SAME_IN_SPANISH].sort((a, b) => b.length - a.length);
  const rest = names.reduce((left, name) => left.split(name).join(" "), value);
  return /^[\s\d.,·-]*$/.test(rest);
}

// Terminal output and code identifiers in the 404 console, which stay as a program prints them.
const CODE = new Set([
  "not-found.consoleTitle",
  "not-found.command",
  "not-found.failure",
  "not-found.infoLabel",
]);

const accent = (text: string): ReactNode => text;
const element: ReactNode = "LINK";

/** FAQ facts with the exchange close live or not, and with or without testnet-only exits. */
function faqFacts(exchangeLive: boolean, testnetOnlyExits: string): FaqFacts {
  return {
    keyStatement: "KEY",
    checkStatement: "CHECK",
    serverKeysIntro: "INTRO",
    serverKeys: [{ name: "NAME", statement: "STATEMENT", scope: "" }],
    verifySourceUrl: "https://example.com/verify.ts",
    newTab: "NEW TAB",
    exchangeLive,
    liveExits: "Blend",
    testnetOnlyExits,
    testnetOnlySentence: "TESTNET ONLY",
    minimumBalance: "1",
    perItem: "0.5",
  };
}

// Arguments for each function in the sections, so its Spanish sentence is read, not only its
// reference. A function with no entry here fails the walk.
const CALLS: Record<string, unknown[][]> = {
  "footer.copyright": [[2026]],
  "hero.console.progress": [[3, 6, "8.50"]],
  "hero.input.reassurance": [[element]],
  "hero.input.playground": [[element]],
  "hero.estimate.about": [["12.50"]],
  "hero.estimate.range": [["10.00", "12.50"]],
  "hero.estimate.blockers": [[0], [1], [3]],
  "hero.estimate.assumptions.unquoted": [[1], [2]],
  "hero.estimate.assumptions.unconvertible": [[1], [2]],
  "hero.estimate.announcement": [["10 to 12 XLM", "Nothing.", "Caveat"]],
  "hero.estimate.readAt": [["12:00"]],
  "faq.items": [[faqFacts(true, "")], [faqFacts(false, "Aquarius")]],
  "landing.description": [[true], [false]],
  "landing.hero.headline": [[accent]],
  "landing.stats.asOf": [["Nov 2026", element]],
  "landing.problem.truths.exchanges.body": [[1]],
  "landing.faq.stillCurious": [[element]],
  "site.list": [[["Alpha", "Beta", "Gamma"]]],
  "site.protocolExits": [["Blend"]],
  "site.testnetOnly": [[["exchange closes", "Blend exits"]]],
  "site.trust.scope": [["Testnet only"]],
  "site.numbers.reserveValue": [[1, 0.5]],
  "site.numbers.example.trustlines": [[1], [4]],
  "site.numbers.example.offers": [[1], [2]],
  "site.numbers.example.dataAndSigner": [
    [1, 1],
    [2, 3],
  ],
  "site.numbers.heroOutcome": [
    [{ minimum: 1, perItem: 0.5, defiLive: true }],
    [{ minimum: 1, perItem: 0.5, defiLive: false }],
  ],
  "site.metadata.blogName": [["LumenWipe"]],
  "site.structuredData.positionExits": [["Blend and Aquarius"]],
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : nodeText(value as ReactNode);

/** A function's result as the walk reads it: a list of entries (the FAQ items) entry by entry,
 *  each field as the text a reader sees, so one entry left in English is reported on its own. */
function readable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readable);
  if (typeof value === "object" && value !== null && !isValidElement(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, readable(v)]));
  }
  return text(value);
}

/** Every way the Spanish copy at `path` is missing or still reads as the English. */
function untranslated(path: string, en: unknown, es: unknown): string[] {
  if (es === undefined) return [`${path}: missing`];
  if (typeof en === "string") {
    if (typeof es !== "string") return [`${path}: not a string`];
    if (es.trim() === "") return [`${path}: empty`];
    return es === en && !onlyNames(en) && !CODE.has(path) ? [`${path}: "${es}"`] : [];
  }
  if (typeof en === "function") {
    if (typeof es !== "function") return [`${path}: not a function`];
    if (es === en) return [`${path}: the English function`];
    const calls = CALLS[path];
    if (!calls) return [`${path}: no arguments listed in CALLS`];
    return calls.flatMap((args, i) => {
      const result: unknown = en(...args);
      if (Array.isArray(result)) {
        return untranslated(`${path}#${i}`, readable(result), readable(es(...args)));
      }
      const spanish = text(es(...args));
      const english = text(en(...args));
      return spanish === "" || (spanish === english && !onlyNames(spanish))
        ? [`${path}(${String(args)}): "${spanish}"`]
        : [];
    });
  }
  if (Array.isArray(en)) {
    if (!Array.isArray(es) || es.length === 0) return [`${path}: not a list`];
    if (en.every((v) => typeof v === "string")) {
      return es.flatMap((v: unknown, i) =>
        typeof v !== "string" || v.trim() === ""
          ? [`${path}[${i}]: empty`]
          : en.includes(v) && !onlyNames(v)
            ? [`${path}[${i}]: "${v}"`]
            : []
      );
    }
  }
  if (isValidElement(en)) return [`${path}: an element, not dictionary copy`];
  if (typeof en === "object" && en !== null) {
    if (typeof es !== "object" || es === null) return [`${path}: not an object`];
    const keys = new Set([...Object.keys(en), ...Object.keys(es)]);
    return [...keys].flatMap((key) =>
      untranslated(
        `${path}.${key}`,
        (en as Record<string, unknown>)[key],
        (es as Record<string, unknown>)[key]
      )
    );
  }
  return [];
}

describe("the Spanish copy of the navigation, footer, 404, landing and FAQ", () => {
  for (const [name, section] of Object.entries(SECTIONS)) {
    test(`${name}: every entry is filled and reads in Spanish`, () => {
      expect(untranslated(name, section.en, section.es)).toEqual([]);
    });
  }

  test("every listed call names a function the sections hold", () => {
    const at = (path: string): unknown =>
      path
        .split(".")
        .slice(1)
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)[key],
          SECTIONS[path.split(".")[0]!]!.en
        );
    for (const path of Object.keys(CALLS)) expect(typeof at(path), path).toBe("function");
  });

  test("the walk reports a missing entry, an English one and a shared function", () => {
    const en = { a: "Open the app", b: (n: number) => `${n} items`, c: "GitHub" };
    expect(untranslated("x", en, { a: "Open the app", b: en.b, c: "GitHub" })).toEqual([
      'x.a: "Open the app"',
      "x.b: the English function",
    ]);
    expect(untranslated("x", en, { b: (n: number) => `${n} elementos`, c: "GitHub" })).toEqual([
      "x.a: missing",
      "x.b: no arguments listed in CALLS",
    ]);
  });

  test("the walk reports one list entry left in English, field by field", () => {
    const en = () => [
      { q: "Is it safe?", a: "Yes." },
      { q: "Is it fast?", a: "Yes, in seconds." },
    ];
    const es = () => [
      { q: "¿Es seguro?", a: "Sí." },
      { q: "Is it fast?", a: "Yes, in seconds." },
    ];
    expect(untranslated("faq.items", en, es)).toEqual([
      'faq.items#0.1.q: "Is it fast?"',
      'faq.items#0.1.a: "Yes, in seconds."',
      'faq.items#1.1.q: "Is it fast?"',
      'faq.items#1.1.a: "Yes, in seconds."',
    ]);
  });
});
