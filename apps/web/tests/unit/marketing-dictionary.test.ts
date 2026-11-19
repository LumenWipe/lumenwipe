import { describe, expect, test } from "bun:test";
import { LOCALES } from "@/lib/i18n/locale";
import { FAQ, type FaqFacts } from "@/lib/i18n/messages/faq";
import { HOW_IT_WORKS } from "@/lib/i18n/messages/how-it-works";
import { HERO } from "@/lib/i18n/messages/hero";
import { LANDING } from "@/lib/i18n/messages/landing";
import { SITE } from "@/lib/i18n/messages/site";
import { monthYear } from "@/lib/site/numbers";
import { features, statusLabels, testnetOnlySentence } from "@/lib/site/status";
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
  minimumBalance: "1",
  perItem: "0.5",
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

    test(`${locale}: the reserve answer shows the reserve it is given`, () => {
      const reserve = FAQ[locale].items(FACTS).findIndex((item) => /XLM/.test(item.q));
      const shown = answer(locale, { ...FACTS, minimumBalance: "7", perItem: "3.5" }, reserve);
      expect(shown).toContain("7 XLM");
      expect(shown).toContain("3.5 XLM");
      expect(shown).not.toContain("0.5 XLM");
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

describe("how it works steps built from the registry", () => {
  for (const locale of LOCALES) {
    test(`${locale}: the DeFi exit step lists every protocol it is given`, () => {
      const op = HOW_IT_WORKS[locale].plan.steps.defi.op;
      expect(op(["Alpha", "Beta"])).toMatch(/Alpha.*Beta/);
      expect(op(["Gamma"])).not.toMatch(/Alpha/);
    });
  }
});

describe("Spanish sentences built from numbers and the registry", () => {
  const es = SITE.es;

  test("counts agree with their noun and verb", () => {
    expect(es.numbers.example.trustlines(1)).toBe("1 trustline");
    expect(es.numbers.example.trustlines(4)).toBe("4 trustlines");
    expect(es.numbers.example.offers(1)).toBe("1 offer abierta");
    expect(es.numbers.example.offers(2)).toBe("2 offers abiertas");
    expect(es.numbers.example.dataAndSigner(2, 1)).toBe("2 data entries · 1 signer");
    expect(HERO.es.estimate.blockers(1)).toBe(
      "1 elemento bloquearía el cierre hasta que se resuelva."
    );
    expect(HERO.es.estimate.blockers(3)).toBe(
      "3 elementos bloquearían el cierre hasta que se resuelvan."
    );
    expect(HERO.es.estimate.assumptions.unconvertible(1)).toBe(
      "1 activo no tiene ruta a XLM y no se cuenta."
    );
    expect(HERO.es.estimate.assumptions.unquoted(2)).toBe(
      "2 activos no tuvieron cotización y cuentan como cero."
    );
  });

  test("names are joined with y, or e before an i sound", () => {
    expect(es.list(["Blend", "Aquarius"])).toBe("Blend y Aquarius");
    expect(es.list(["Blend", "Aquarius", "Iris"])).toBe("Blend, Aquarius e Iris");
    expect(es.testnetOnly(["los cierres hacia un exchange", "las salidas de FxDAO"])).toBe(
      "Los cierres hacia un exchange y las salidas de FxDAO funcionan solo en testnet por ahora."
    );
  });

  test("figures are written as an es-419 reader writes them", () => {
    expect(es.numbers.reserveValue(1, 0.5)).toBe("1 XLM más 0.5 por elemento");
    expect(es.numbers.example.trustlines(1500)).toBe("1,500 trustlines");
    expect(monthYear("2026-11-14", "es")).toBe("nov 2026");
    expect(LANDING.es.problem.truths.exchanges.body(1)).toContain("el mínimo de 1 XLM");
  });

  test("the registry sentences follow the registry in Spanish too", () => {
    const sentence = testnetOnlySentence("es");
    const names = features("es")
      .filter((f) => f.status === "testnet-only")
      .map((f) => f.noun);
    for (const noun of names) expect(sentence.toLowerCase()).toContain(noun);
    expect(sentence).toMatch(/funcionan solo en testnet por ahora\.$/);
    expect(statusLabels("es")).toEqual({
      live: "Disponible",
      "testnet-only": "Solo en testnet",
      soon: "Próximamente",
    });
  });
});
