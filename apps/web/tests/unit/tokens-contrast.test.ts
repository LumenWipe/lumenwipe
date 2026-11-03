import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import {
  PAIRS,
  TINT_MINIMUM,
  TINT_SURFACES,
  measure,
  measureDangerTint,
  ratio,
  rootVars,
} from "../design-tokens";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

const vars = rootVars(css);

function token(name: string): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`token --${name} is missing from globals.css`);
  return value;
}

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
  const rows = PAIRS.map((p) => ({
    foreground: p.fg,
    background: p.bg,
    ratio: measure(vars, p.fg, p.bg),
    minimum: p.min,
  }));

  test("prints the measured ratios", () => {
    console.table(rows);
    expect(rows.length).toBe(PAIRS.length);
  });

  for (const row of rows) {
    test(`${row.foreground} on ${row.background} is at least ${row.minimum}:1`, () => {
      expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
    });
  }
});

describe("callout text over its tint", () => {
  for (const surface of TINT_SURFACES) {
    test(`danger-fg stays at 7:1 on the danger tint over ${surface}`, () => {
      expect(measureDangerTint(vars, surface)).toBeGreaterThanOrEqual(TINT_MINIMUM);
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
