import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

const root = process.cwd();
const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return /\.tsx$/.test(entry.name) ? [rel] : [];
  });
}

const files = ["app", "components"].flatMap(walk).map((rel) => ({
  rel,
  src: fs.readFileSync(path.join(root, rel), "utf8"),
}));

const GROUP_RING = "has-[input:focus-visible]:outline-focus";

describe("global focus ring", () => {
  test("the base stylesheet declares one :focus-visible rule on the focus token", () => {
    const base = css.slice(css.indexOf("@layer base"));
    const rule = base.match(/(?<![\w-]):focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/outline:\s*2px solid hsl\(var\(--focus\)\)/);
    expect(rule?.[1]).toMatch(/outline-offset:\s*2px/);
  });

  test("the ring is not applied on plain :focus so mouse clicks stay clean", () => {
    expect(css).not.toMatch(/(^|\s|,)(\*|input|button|a):focus\s*\{/);
  });

  test("no component strips the outline without a visible replacement", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      for (const m of src.matchAll(/(?<![\w-])((?:[a-z-]+:)*)outline-none/g)) {
        const idx = m.index ?? 0;
        const tag = src.slice(src.lastIndexOf("<", idx), idx);
        const programmaticFocusOnly = /tabIndex=\{-1\}/.test(tag);
        const groupReplacement = m[1] === "focus-visible:" && src.includes(GROUP_RING);
        if (!programmaticFocusOnly && !groupReplacement) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no weak translucent focus ring remains", () => {
    const offenders = files.flatMap(({ rel, src }) =>
      [...src.matchAll(/focus(?:-visible|-within)?:ring-[\w-]+\/\d+/g)].map(
        (m) => `${rel}: ${m[0]}`
      )
    );
    expect(offenders).toEqual([]);
  });

  test("full-width accordion triggers inside overflow-hidden containers draw the ring inward", () => {
    for (const rel of [
      "components/plan/PlanAccordion.tsx",
      "components/review/PlanStepAccordion.tsx",
      "components/marketing/Faq.tsx",
    ]) {
      const src = files.find((f) => f.rel === rel)?.src ?? "";
      expect(src).toContain("focus-visible:-outline-offset-2");
    }
  });
});
