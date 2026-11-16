import { describe, expect, test } from "bun:test";
import path from "path";
import fs from "fs";
import { ESLint } from "eslint";
import { DICTIONARY_COPY } from "../../eslint.config.mjs";

const root = process.cwd();
const eslint = new ESLint({ cwd: root });
const COMPONENT = "components/marketing/HeroConsole.tsx";
const MODULE = "lib/site/status.ts";

async function copyMessages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, filePath) });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax" && /locale dictionary/.test(m.message))
    .map((m) => m.message);
}

function component(jsx: string, before = ""): string {
  return `${before}\nexport function Fixture({ ok, n, T }: { ok: boolean; n: number; T: Record<string, string> }) {\n  return (\n    <>\n      ${jsx}\n    </>\n  );\n}\n`;
}

const FLAGGED: Record<string, { code: string; count: number }> = {
  "text in markup": { code: component("<p>Hello there</p>"), count: 1 },
  "a short label in markup": { code: component("<h2>FAQ</h2>"), count: 1 },
  "an aria-label": { code: component('<input aria-label="Search accounts" />'), count: 1 },
  "a placeholder in braces": { code: component('<input placeholder={"Search"} />'), count: 1 },
  "both branches of an aria-label ternary": {
    code: component('<button aria-label={ok ? "Close" : "Open"} />'),
    count: 2,
  },
  "a string child": { code: component('<p>{"Hello"}</p>'), count: 1 },
  "both branches of a ternary child": { code: component('<p>{ok ? "Yes" : "No"}</p>'), count: 2 },
  "the right of an && child": { code: component('<p>{ok && "Shown"}</p>'), count: 1 },
  "a template child": { code: component("<p>{`Total ${n}`}</p>"), count: 1 },
  "a page title": {
    code: 'export const metadata = pageMetadata({ path: "/x", title: "Title", description: T.d });',
    count: 1,
  },
  "prose in a constant": {
    code: 'export const ROWS = [{ n: "01", label: "Normalize the signers" }];',
    count: 1,
  },
};

describe("hard-coded marketing copy lint", () => {
  for (const [name, { code, count }] of Object.entries(FLAGGED)) {
    test(`flags ${name}`, async () => {
      expect(await copyMessages(code, COMPONENT)).toHaveLength(count);
    }, 30_000);
  }

  test("flags prose in a site module", async () => {
    const code = 'export const KEY_STATEMENT = "Your key stays in your browser";\n';
    expect(await copyMessages(code, MODULE)).toHaveLength(1);
  }, 30_000);

  test("passes class names, URLs, roles, identifiers, directives and dictionary reads", async () => {
    const code = component(
      [
        '<div className="mx-auto max-w-6xl text-white underline underline-offset-4" />',
        '<div className={cn("flex items center gap", ok && "sr only now")} />',
        '<div className={`group inline flex ${ok ? "text white now" : "text fg muted"}`} />',
        '<input groupClassName="rounded-2xl border border-line-strong bg-white/[0.04]" />',
        '<a href="https://docs.lumenwipe.com" rel="noopener noreferrer" target="_blank" />',
        '<div role="region" aria-hidden data-site-status="testnet-only" />',
        '<span>{ok ? "✓" : "✗"}</span>',
        "<span>XLM</span>",
        '<span>{T.label}{" "}{T.other}</span>',
        "<span>{` ${T.label}`}</span>",
        "<p>{n === 1 ? T.one : T.many}</p>",
        '<p>{T.items.filter((i) => i !== "testnet-only").length}</p>',
      ].join("\n      "),
      [
        '"use client";',
        'import Link from "next/link";',
        'export { default as Other } from "./Other";',
        'const DESKTOP = "(min-width: 1024px)";',
        'const reduce = () => window.matchMedia?.("(prefers-reduced-motion: reduce)");',
        "function fail(id: string): never {",
        "  throw new Error(`Unknown feature in the registry ${id}`);",
        "}",
      ].join("\n")
    );
    expect(await copyMessages(code, COMPONENT)).toEqual([]);
  }, 30_000);

  test("every file whose copy moved to the dictionary passes", async () => {
    const flagged: string[] = [];
    for (const file of DICTIONARY_COPY) {
      const code = fs.readFileSync(path.join(root, file), "utf8");
      flagged.push(...(await copyMessages(code, file)).map(() => file));
    }
    expect(flagged).toEqual([]);
  }, 60_000);
});
