import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function rootVars(): Record<string, string> {
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n  }\n", start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const vars = rootVars();

function token(name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`token --${name} is missing from globals.css`);
  return value;
}

function toRgb(hsl: string): [number, number, number] {
  const m = hsl.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`not an "H S% L%" triple: ${hsl}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function luminance(hsl: string): number {
  return relativeLuminance(toRgb(hsl));
}

function ratio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const SURFACES = ["bg", "surface", "surface-raised", "surface-sunken"] as const;

interface Pair {
  fg: string;
  bg: string;
  min: number;
}

const pairs: Pair[] = [];
const onSurfaces = (fg: string, min: number): void => {
  for (const bg of SURFACES) pairs.push({ fg, bg, min });
};
for (const t of ["fg", "fg-muted", "fg-subtle", "accent", "value", "success", "warning"]) {
  onSurfaces(t, 4.5);
}
onSurfaces("fg-disabled", 3);
onSurfaces("danger-fg", 7);
onSurfaces("line-strong", 3);
onSurfaces("edge", 3);
onSurfaces("focus", 3);
pairs.push(
  { fg: "accent-fg", bg: "accent", min: 4.5 },
  { fg: "value-fg", bg: "value", min: 4.5 },
  { fg: "warning-fg", bg: "warning", min: 4.5 },
  { fg: "danger-on-fill", bg: "danger", min: 4.5 }
);

describe("contrast calculator", () => {
  test("matches known WCAG values", () => {
    expect(ratio("0 0% 100%", "0 0% 0%")).toBeCloseTo(21, 5);
    expect(ratio("0 0% 50%", "0 0% 50%")).toBeCloseTo(1, 5);
  });

  test("measures the danger fill as unreadable text on the page background", () => {
    expect(ratio(token("danger"), token("bg"))).toBeLessThan(2.1);
  });
});

describe("token surfaces", () => {
  test("bg, surface and surface-raised are the colors users actually see", () => {
    expect(token("bg")).toBe("197 30% 4.5%");
    expect(token("surface")).toBe("200 18% 8%");
    expect(token("surface-raised")).toBe("198 17% 10.5%");
  });
});

describe("WCAG contrast of every token pair", () => {
  const rows = pairs.map((p) => ({
    foreground: p.fg,
    background: p.bg,
    ratio: Number(ratio(token(p.fg), token(p.bg)).toFixed(2)),
    minimum: p.min,
  }));

  test("prints the measured ratios", () => {
    console.table(rows);
    expect(rows.length).toBe(pairs.length);
  });

  for (const row of rows) {
    test(`${row.foreground} on ${row.background} is at least ${row.minimum}:1`, () => {
      expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
    });
  }
});

describe("callout text over its tint", () => {
  for (const surface of ["bg", "surface", "surface-raised"]) {
    test(`danger-fg stays at 7:1 on the danger tint over ${surface}`, () => {
      const fill = toRgb(token("danger"));
      const base = toRgb(token(surface));
      const tint = fill.map((c, i) => c * 0.1 + base[i] * 0.9) as [number, number, number];
      const text = luminance(token("danger-fg"));
      expect((text + 0.05) / (relativeLuminance(tint) + 0.05)).toBeGreaterThanOrEqual(7);
    });
  }
});

describe("token set completeness", () => {
  const required = [
    "bg",
    "surface",
    "surface-raised",
    "surface-sunken",
    "line",
    "line-strong",
    "edge",
    "fg",
    "fg-muted",
    "fg-subtle",
    "fg-disabled",
    "accent",
    "accent-fg",
    "value",
    "value-fg",
    "success",
    "warning",
    "warning-fg",
    "danger",
    "danger-on-fill",
    "danger-fg",
    "focus",
    "space-1",
    "space-2",
    "space-3",
    "space-4",
    "space-5",
    "space-6",
    "space-8",
    "space-control",
    "radius-sm",
    "radius-md",
    "radius-lg",
    "radius-xl",
    "text-caption",
    "text-label",
    "text-body-sm",
    "text-body",
    "text-title",
    "text-heading",
    "text-display",
    "text-hero",
    "duration-fast",
    "duration-base",
    "duration-slow",
    "ease-standard",
  ];

  for (const name of required) {
    test(`--${name} is defined`, () => {
      expect(token(name).length).toBeGreaterThan(0);
    });
  }

  test("every type step is at least 11px", () => {
    for (const name of Object.keys(vars).filter((n) => n.startsWith("text-"))) {
      expect(parseFloat(token(name)) * 16).toBeGreaterThanOrEqual(11);
    }
  });

  test("the control minimum height is 44px", () => {
    expect(parseFloat(token("space-control")) * 16).toBe(44);
  });
});

describe("one token layer", () => {
  const removed = [
    "background",
    "foreground",
    "card",
    "popover",
    "primary",
    "secondary",
    "muted",
    "destructive",
    "border",
    "input",
    "ring",
    "stellar",
    "accent-solid",
    "value-foreground",
  ];

  test("no shadcn or marketing variable remains", () => {
    expect(Object.keys(vars).filter((n) => removed.includes(n) || /-foreground$/.test(n))).toEqual(
      []
    );
    expect(Object.keys(vars).filter((n) => n.startsWith("mkt-"))).toEqual([]);
  });

  test("no surface, line or text value is defined twice", () => {
    const roles = Object.keys(vars).filter((n) => /^(bg|surface|line|edge|fg|accent$)/.test(n));
    const values = roles.map((n) => vars[n]);
    expect(new Set(values).size).toBe(values.length);
  });
});
