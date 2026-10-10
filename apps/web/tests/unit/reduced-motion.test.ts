import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const layout = fs.readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");

function blocks(source: string, at: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(at, from);
    if (start === -1) return out;
    let depth = 0;
    let end = source.indexOf("{", start);
    const open = end;
    for (end = open; end < source.length; end++) {
      if (source[end] === "{") depth++;
      if (source[end] === "}" && --depth === 0) break;
    }
    out.push(source.slice(open + 1, end));
    from = end;
  }
}

function hslToHex(triple: string): string {
  const m = triple.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`not an "H S% L%" triple: ${triple}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return `#${[f(0), f(8), f(4)]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

const reduced = blocks(css, "@media (prefers-reduced-motion: reduce)");

describe("reduced motion", () => {
  test("a global reset shortens every animation and transition and drops smooth scrolling", () => {
    const global = reduced.find((b) => /\*\s*,\s*::before\s*,\s*::after/.test(b));
    expect(global).toBeDefined();
    expect(global).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(global).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(global).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(global).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  test("the reset does not remove animations outright so spinners stay visible", () => {
    const global = reduced.find((b) => /\*\s*,\s*::before\s*,\s*::after/.test(b)) ?? "";
    expect(global).not.toMatch(/animation:\s*none/);
    expect(global).not.toMatch(/display:\s*none/);
  });

  test("the marketing reduced-motion block is kept", () => {
    const marketing = reduced.find((b) => b.includes(".mkt-reveal"));
    expect(marketing).toBeDefined();
    expect(marketing).toContain(".mkt-marquee");
    expect(marketing).toContain(".mkt-sweep");
  });

  test("the components that read matchMedia keep doing so", () => {
    for (const rel of [
      "components/marketing/HeroConsole.tsx",
      "components/marketing/ExecutionPlanDemo.tsx",
    ]) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src).toContain("(prefers-reduced-motion: reduce)");
    }
  });
});

describe("dark color scheme", () => {
  test("the root declares color-scheme dark", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n  }\n", css.indexOf(":root {")));
    expect(root).toMatch(/color-scheme:\s*dark;/);
  });

  test("the root layout exports a dark viewport whose themeColor equals the page background token", () => {
    const bg = css.match(/--bg:\s*([^;]+);/)?.[1].trim() ?? "";
    expect(layout).toContain("export const viewport");
    expect(layout).toMatch(/colorScheme:\s*"dark"/);
    expect(layout.match(/themeColor:\s*"(#[0-9a-f]{6})"/)?.[1]).toBe(hslToHex(bg));
  });
});
