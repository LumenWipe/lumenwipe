import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { relativeLuminance, rootVars, toRgb, type Rgb } from "../design-tokens";

const root = process.cwd();
const vars = rootVars(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"));

const MARKETING = [
  "app/(marketing)",
  "app/global-not-found.tsx",
  "app/(app)/not-found.tsx",
  "app/(app)/api-keys",
  "components/marketing",
  "components/blog",
  "lib/i18n/messages",
];
// The ink and the card surface marketing text sits on.
const SURFACES = ["bg", "surface-raised"] as const;
const MINIMUM = 4.5;
const WHITE = "0 0% 100%";
// fg-disabled is for decorative and disabled elements, held to 3:1 by tokens-contrast.
const COLORS = ["white", "fg", "fg-muted", "fg-subtle", "accent", "value", "success", "warning"];
const TEXT = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*text-(${[...COLORS, "danger-fg"].join("|")})(?:/(\\d+|\\[[\\d.]+\\]))?(?![\\w-])`,
  "g"
);

function walk(rel: string): string[] {
  const abs = path.join(root, rel);
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) return walk(child);
    return /\.tsx?$/.test(e.name) ? [child] : [];
  });
}

function color(name: string): Rgb {
  if (name === "white") return toRgb(WHITE);
  const value = vars[name];
  if (value === undefined) throw new Error(`token --${name} is missing from globals.css`);
  return toRgb(value);
}

function alpha(modifier: string | undefined): number {
  if (modifier === undefined) return 1;
  return modifier.startsWith("[") ? Number(modifier.slice(1, -1)) : Number(modifier) / 100;
}

/** The contrast of a text color class over a surface token, its alpha blended as a browser does. */
function textContrast(name: string, modifier: string | undefined, surface: string): number {
  const fg = color(name);
  const bg = color(surface);
  const a = alpha(modifier);
  const blended = fg.map((c, i) => c * a + bg[i]! * (1 - a)) as Rgb;
  const [hi, lo] = [relativeLuminance(blended), relativeLuminance(bg)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

function offenders(rel: string, src: string): string[] {
  return [...src.matchAll(TEXT)].flatMap((m) =>
    SURFACES.map((s) => [s, textContrast(m[1]!, m[2], s)] as const)
      .filter(([, r]) => r < MINIMUM)
      .map(([s, r]) => `${rel}: ${m[0]} is ${r.toFixed(2)}:1 on --${s}`)
  );
}

describe("marketing text contrast", () => {
  test("measures white at 70 percent and a dimmed accent on the ink", () => {
    expect(textContrast("white", "70", "bg")).toBeGreaterThan(MINIMUM);
    expect(textContrast("accent", "40", "bg")).toBeLessThan(MINIMUM);
    expect(textContrast("fg-subtle", undefined, "bg")).toBeGreaterThan(MINIMUM);
  });

  test("flags a deliberately dimmed class and passes the floor tokens", () => {
    const flagged = offenders("fixture.tsx", 'const a = "text-accent/40 hover:text-white/30";');
    expect(flagged).toHaveLength(4);
    expect(
      offenders("fixture.tsx", 'const a = "text-white/70 text-fg-subtle text-value";')
    ).toEqual([]);
  });

  test("every text color on a marketing page is at least 4.5:1 on the ink and on a card", () => {
    const found = MARKETING.flatMap(walk).flatMap((rel) =>
      offenders(rel, fs.readFileSync(path.join(root, rel), "utf8"))
    );
    expect(found).toEqual([]);
  });
});
