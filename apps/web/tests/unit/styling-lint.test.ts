import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { ESLint } from "eslint";
import { BANNED_CLASSES } from "./fixtures/banned-styling";

const root = process.cwd();
const eslint = new ESLint({ cwd: root });
const fixture = fs.readFileSync(path.join(root, "tests/unit/fixtures/banned-styling.tsx"), "utf8");

const MESSAGES: Record<keyof typeof BANNED_CLASSES, RegExp> = {
  destructive: /text-danger-fg/,
  palette: /Raw palette colors/,
  paletteVariant: /Raw palette colors/,
  paletteOther: /Raw palette colors/,
  stellar: /stellar was a transitional alias/,
  stellarModifier: /stellar was a transitional alias/,
  black: /text-accent-fg on bg-accent/,
  remSize: /type scale/,
  pxSize: /type scale/,
};

async function lint(code: string, filePath: string): Promise<ESLint.LintResult["messages"]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, filePath) });
  return result.messages;
}

async function syntaxMessages(code: string, filePath: string): Promise<string[]> {
  return (await lint(code, filePath))
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("raw styling lint", () => {
  for (const [name, cls] of Object.entries(BANNED_CLASSES) as [
    keyof typeof BANNED_CLASSES,
    string,
  ][]) {
    test(`flags ${cls} outside components/ui with a message naming the replacement`, async () => {
      const code = `export const a = "flex ${cls}";\nexport const b = \`flex ${cls} \${a}\`;\n`;
      for (const file of ["components/plan/Fixture.tsx", "app/[network]/fixture/page.tsx"]) {
        const messages = await syntaxMessages(code, file);
        expect(messages).toHaveLength(2);
        for (const message of messages) expect(message).toMatch(MESSAGES[name]);
      }
    }, 30_000);
  }

  test("the fixture fails outside components/ui and passes inside it", async () => {
    const outside = await syntaxMessages(fixture, "components/plan/BannedStyling.tsx");
    expect(outside).toHaveLength(Object.keys(BANNED_CLASSES).length + 5);
    expect(await syntaxMessages(fixture, "components/ui/banned-styling.tsx")).toEqual([]);
  }, 30_000);

  test("token classes pass", async () => {
    const code = `export const a = "text-danger-fg bg-accent text-accent-fg text-caption md:text-label text-accent/70 accent-accent bg-[hsl(var(--accent))] text-[hsl(var(--fg))]";\n`;
    expect(await syntaxMessages(code, "components/plan/Fixture.tsx")).toEqual([]);
  }, 30_000);

  test("components/ui keeps the dim white text rule", async () => {
    const messages = await syntaxMessages(
      `export const a = "text-white/40";\n`,
      "components/ui/fixture.tsx"
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/white opacity at or below 55/);
  }, 30_000);

  test("the closing module boundary still fires in app, components and components/ui", async () => {
    const code = `import { buildClose } from "@/lib/close-api";\nexport const a = buildClose;\n`;
    for (const file of [
      "components/plan/Fixture.tsx",
      "components/ui/fixture.tsx",
      "app/fixture/page.tsx",
    ]) {
      const restricted = (await lint(code, file)).filter(
        (m) => m.ruleId === "no-restricted-imports"
      );
      expect(restricted).toHaveLength(1);
      expect(restricted[0].message).toMatch(/Account-closing logic lives in the API/);
    }
  }, 30_000);
});

describe("gold is never an action", () => {
  const GOLD = /Gold is recovered value only/;
  const FILL = /text on a gold fill/;

  test("a gold class on a button or link is flagged anywhere in the web", async () => {
    const code = [
      'import Link from "next/link";',
      'export const A = () => <Link href="/" className="bg-value text-white">a</Link>;',
      "export const B = () => <button className={`flex hover:bg-value/90`}>b</button>;",
      'export const C = () => <a href="/" className="text-value">c</a>;',
      'export const D = () => <Button asChild className="border-value/40">d</Button>;',
      "",
    ].join("\n");
    for (const file of [
      "components/marketing/Fixture.tsx",
      "app/(marketing)/fixture/page.tsx",
      "components/plan/Fixture.tsx",
      "components/ui/fixture.tsx",
    ]) {
      const messages = await syntaxMessages(code, file);
      expect(messages.filter((m) => GOLD.test(m))).toHaveLength(4);
    }
  }, 30_000);

  test("a gold amount inside a link and a gold reserve bar pass", async () => {
    const code = [
      'import Link from "next/link";',
      'export const A = () => <Link href="/" className="text-accent"><span className="text-value">1 XLM</span></Link>;',
      'export const B = () => <div className="h-full bg-value" />;',
      "",
    ].join("\n");
    expect(await syntaxMessages(code, "components/marketing/Fixture.tsx")).toEqual([]);
  }, 30_000);

  test("the text of a gold fill is flagged on marketing pages, even held in a constant", async () => {
    const code = 'export const btn = "rounded-xl px-5 text-value-fg";\n';
    for (const file of ["components/marketing/Fixture.tsx", "app/not-found.tsx"]) {
      const messages = await syntaxMessages(code, file);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(FILL);
    }
  }, 30_000);
});

describe("marketing text alpha floor", () => {
  const FLOOR = /white at 70 percent or more/;

  test("white below 70 is flagged on every marketing surface and nowhere else", async () => {
    const code = 'export const a = "text-white/65";\nexport const b = "hover:text-white/56";\n';
    for (const file of [
      "app/(marketing)/fixture/page.tsx",
      "app/not-found.tsx",
      "components/marketing/Fixture.tsx",
      "components/blog/Fixture.tsx",
    ]) {
      const messages = await syntaxMessages(code, file);
      expect(messages).toHaveLength(2);
      for (const message of messages) expect(message).toMatch(FLOOR);
    }
    expect(await syntaxMessages(code, "components/plan/Fixture.tsx")).toEqual([]);
  }, 30_000);

  test("the body floor and the caption tokens pass", async () => {
    const code = 'export const a = "text-white/70 text-white/85 text-fg-muted text-fg-subtle";\n';
    expect(await syntaxMessages(code, "components/marketing/Fixture.tsx")).toEqual([]);
  }, 30_000);
});
