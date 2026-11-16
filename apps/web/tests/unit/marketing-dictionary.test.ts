import { describe, expect, test } from "bun:test";
import { LOCALES } from "@/lib/i18n/locale";
import { FAQ, type FaqFacts } from "@/lib/i18n/messages/faq";
import { SITE } from "@/lib/i18n/messages/site";
import { nodeText } from "@/lib/site/node-text";

const FACTS: FaqFacts = {
  keyStatement: "Key.",
  checkStatement: "Check.",
  serverKeysIntro: "Keys.",
  serverKeys: [],
  verifySourceUrl: "https://example.com/verify.ts",
  newTab: " (new tab)",
  exchangeLive: false,
  liveExits: "Alpha and Beta",
  testnetOnlyExits: "",
  testnetOnlySentence: "",
};

function answer(locale: (typeof LOCALES)[number], facts: FaqFacts, question: number): string {
  return nodeText(FAQ[locale].items(facts)[question].a);
}

describe("sentences built from the registry", () => {
  for (const locale of LOCALES) {
    test(`${locale}: the DeFi answer names testnet-only exits only when there are some`, () => {
      const defi = FAQ[locale].items(FACTS).findIndex((item) => /DeFi/.test(item.q));
      expect(answer(locale, FACTS, defi)).not.toMatch(/testnet/);
      expect(answer(locale, { ...FACTS, testnetOnlyExits: "Gamma" }, defi)).toMatch(/Gamma/);
    });

    test(`${locale}: the exchange answer follows the relay's status`, () => {
      const exchange = FAQ[locale].items(FACTS).findIndex((item) => /exchange/.test(item.q));
      expect(answer(locale, FACTS, exchange)).not.toBe(
        answer(locale, { ...FACTS, exchangeLive: true }, exchange)
      );
    });

    test(`${locale}: the testnet sentence lists every name it is given`, () => {
      const sentence = SITE[locale].testnetOnly(["exchange closes", "Gamma exits"]);
      expect(sentence).toContain("Gamma exits");
      expect(sentence.charAt(0)).toBe(sentence.charAt(0).toUpperCase());
    });

    test(`${locale}: the hero outcome mentions DeFi exits only while they are live`, () => {
      const outcome = (defiLive: boolean): string =>
        SITE[locale].numbers.heroOutcome({ minimum: 1, perItem: 0.5, defiLive });
      expect(outcome(true)).toMatch(/DeFi/);
      expect(outcome(false)).not.toMatch(/DeFi/);
    });
  }
});
