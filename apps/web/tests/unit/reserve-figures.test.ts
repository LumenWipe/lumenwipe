import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { formatNumber } from "@/lib/i18n/format";
import { LOCALES } from "@/lib/i18n/locale";
import { HOW_IT_WORKS } from "@/lib/i18n/messages/how-it-works";
import { LANDING } from "@/lib/i18n/messages/landing";
import { BASE_RESERVE_XLM } from "@/lib/site/reserve";

const MESSAGES = join(import.meta.dir, "..", "..", "lib", "i18n", "messages");

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An amount written next to XLM, or the base reserve as any locale prints it. Only the literal text
// of the source is read (string literals, template text and JSX text), never what a `${}`
// interpolates, so a generated sentence passes and a count or a date is no amount.
const AMOUNT_IN_XLM = /(?<![\w.,])\d+(?:[.,]\d+)?\s*XLM\b/;
const BASE_RESERVE = new RegExp(
  `(?<![\\w.,])(?:${[...new Set(LOCALES.map((l) => formatNumber(l, BASE_RESERVE_XLM)))]
    .map(escape)
    .join("|")})(?![\\w.,]*\\d)`
);

/** Each literal reserve amount in `source`, as `line: text`. */
export function literalReserveAmounts(source: string, fileName = "file.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      if (
        !ts.isImportDeclaration(node.parent) &&
        (AMOUNT_IN_XLM.test(text) || BASE_RESERVE.test(text))
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push(`${line + 1}: ${text.trim().slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("reserve figures in the marketing dictionaries", () => {
  test("no dictionary writes a reserve amount as a literal", () => {
    const files = readdirSync(MESSAGES)
      .filter((name) => /\.tsx?$/.test(name))
      .sort();
    expect(files).toContain("how-it-works.tsx");
    const found = files.flatMap((name) =>
      literalReserveAmounts(readFileSync(join(MESSAGES, name), "utf8"), name).map(
        (hit) => `${name}:${hit}`
      )
    );
    expect(found).toEqual([]);
  });

  test("the scan flags a literal amount and the base reserve, and passes generated ones", () => {
    expect(literalReserveAmounts(`const a = "release 0.5 XLM each";`)).toHaveLength(1);
    expect(literalReserveAmounts(`const a = "1 XLM for the account";`)).toHaveLength(1);
    expect(literalReserveAmounts(`const a = <p>plus 0.5 for every trustline</p>;`)).toHaveLength(1);
    expect(literalReserveAmounts("const a = `holds 1 XLM, plus ${n}`;")).toHaveLength(1);
    expect(literalReserveAmounts("const a = (n: string) => `release ${n} XLM each`;")).toEqual([]);
    expect(literalReserveAmounts(`const a = "Eight steps, 2 rounds, v0.50, 10.5 days";`)).toEqual(
      []
    );
  });

  for (const locale of LOCALES) {
    test(`${locale}: the how it works and landing sentences show the reserve they are given`, () => {
      const steps = HOW_IT_WORKS[locale].plan.steps;
      expect(steps.data.body("7")).toContain("7 XLM");
      expect(steps.trustlines.body("7")).toContain("7 XLM");
      const problem = LANDING[locale].problem.body("9", "4.5");
      expect(problem).toContain("9 XLM");
      expect(problem).toContain("4.5");
      expect(problem).not.toContain(formatNumber(locale, BASE_RESERVE_XLM));
    });
  }
});
