import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import postcss from "postcss";
import tailwind from "tailwindcss";
import config from "../../tailwind.config";

const root = process.cwd();
const SCAN_DIRS = ["app", "components"];
const COLOR_PREFIXES =
  "text|bg|border|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent";
const NON_CLOSE_FLOW = [/^components\/blog\//];

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return /\.(tsx|ts)$/.test(entry.name) ? [rel] : [];
  });
}

const files = SCAN_DIRS.flatMap(walk).map((rel) => ({
  rel,
  src: fs.readFileSync(path.join(root, rel), "utf8"),
}));

function candidates(src: string): string[] {
  const re = new RegExp(
    `(?<![\\w\\-\\[])((?:[a-z0-9-]+:)*-?(?:${COLOR_PREFIXES})-(?:\\[[^\\]\\s]+\\]|[a-z0-9]+(?:-[a-z0-9]+)*)(?:/(?:\\d+|\\[[^\\]]+\\]))?)(?![\\w-])`,
    "g"
  );
  return [...src.matchAll(re)].map((m) => m[1]);
}

async function emittedSelectors(classes: string[]): Promise<Set<string>> {
  const result = await postcss([
    tailwind({ ...config, content: [{ raw: classes.join(" ") }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  const emitted = new Set<string>();
  result.root.walkRules((rule) => {
    for (const m of rule.selector.matchAll(/\.((?:\\.|[^\s.:>+~,[\]()])+)/g)) {
      emitted.add(m[1].replace(/\\(.)/g, "$1"));
    }
  });
  return emitted;
}

describe("color utility classes", () => {
  test("text-destructive is never used as a text or icon color", () => {
    const offenders = files.flatMap(({ rel, src }) =>
      [...src.matchAll(/(?<![\w-])(?:[a-z-]+:)*text-destructive(?!-)(?:\/\d+)?/g)].map(
        (m) => `${rel}: ${m[0]}`
      )
    );
    expect(offenders).toEqual([]);
  });

  test("close-flow files use semantic color tokens instead of raw red or emerald palette classes", () => {
    const offenders = files
      .filter(({ rel }) => !NON_CLOSE_FLOW.some((re) => re.test(rel)))
      .flatMap(({ rel, src }) =>
        [
          ...src.matchAll(
            /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring)-(?:red|emerald)-\d+(?:\/\d+)?/g
          ),
        ].map((m) => `${rel}: ${m[0]}`)
      );
    expect(offenders).toEqual([]);
  });

  test("every color utility used in the source generates CSS", async () => {
    const used = new Map<string, string>();
    for (const { rel, src } of files) for (const c of candidates(src)) used.set(c, rel);
    const emitted = await emittedSelectors([...used.keys()]);
    const unknown = [...used].filter(([c]) => !emitted.has(c)).map(([c, rel]) => `${rel}: ${c}`);
    expect(unknown).toEqual([]);
  });

  test("danger and success are registered so their utilities generate CSS", async () => {
    const emitted = await emittedSelectors([
      "border-danger/30",
      "bg-danger/5",
      "bg-danger",
      "text-danger-fg",
      "text-success",
      "bg-success/10",
      "border-success/30",
    ]);
    for (const c of [
      "border-danger/30",
      "bg-danger/5",
      "bg-danger",
      "text-danger-fg",
      "text-success",
      "bg-success/10",
      "border-success/30",
    ]) {
      expect(emitted.has(c)).toBe(true);
    }
  });

  test("text-danger is the dark fill color and is not for text", () => {
    const colors = (config.theme?.extend as { colors: Record<string, Record<string, string>> })
      .colors;
    expect(colors.danger.DEFAULT).toBe("hsl(var(--danger) / <alpha-value>)");
    for (const { rel, src } of files) {
      expect(`${rel}:${/(?<![\w-])text-danger(?![-\w])/.test(src)}`).toBe(`${rel}:false`);
    }
  });
});
