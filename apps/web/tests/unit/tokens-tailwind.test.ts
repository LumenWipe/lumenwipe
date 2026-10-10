import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import config from "../../tailwind.config";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const extend = (config.theme?.extend ?? {}) as Record<string, Record<string, unknown>>;

function flatten(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (value && typeof value === "object") return Object.values(value).flatMap(flatten);
  return [];
}

describe("tailwind token registration", () => {
  const colors = extend.colors as Record<string, Record<string, string> | string>;

  test("new color roles support opacity modifiers", () => {
    const flat = (v: unknown): string[] => flatten(v);
    for (const key of ["canvas", "surface", "line", "fg", "success", "danger", "focus"]) {
      for (const value of flat(colors[key])) expect(value).toContain("<alpha-value>");
    }
    expect(flat(colors.accent)).toContain("hsl(var(--accent-solid) / <alpha-value>)");
    expect(flat(colors.accent)).toContain("hsl(var(--accent-solid-fg) / <alpha-value>)");
    expect(flat(colors.value)).toContain("hsl(var(--value-foreground) / <alpha-value>)");
    expect(flat(colors.warning)).toContain("hsl(var(--warning-fg) / <alpha-value>)");
  });

  test("danger registers the fill and the text pair", () => {
    expect(colors.danger).toEqual({
      DEFAULT: "hsl(var(--danger) / <alpha-value>)",
      fg: "hsl(var(--danger-fg) / <alpha-value>)",
    });
  });

  test("legacy color keys keep their values", () => {
    expect(colors.accent).toMatchObject({ foreground: "hsl(var(--accent-foreground))" });
    expect(colors.warning).toMatchObject({
      DEFAULT: "hsl(var(--warning))",
      foreground: "hsl(var(--warning-foreground))",
    });
    expect(colors.destructive).toEqual({
      DEFAULT: "hsl(var(--destructive))",
      foreground: "hsl(var(--destructive-foreground))",
    });
    expect(colors.background).toBe("hsl(var(--background))");
    expect(extend.borderRadius).toMatchObject({
      lg: "var(--radius)",
      md: "calc(var(--radius) - 2px)",
      sm: "calc(var(--radius) - 4px)",
    });
  });

  test("scale, radius, spacing and motion keys exist", () => {
    expect(Object.keys(extend.fontSize)).toEqual(
      expect.arrayContaining([
        "caption",
        "label",
        "body-sm",
        "body",
        "title",
        "heading",
        "display",
        "hero",
      ])
    );
    expect(Object.keys(extend.borderRadius)).toEqual(
      expect.arrayContaining(["badge", "control", "card", "dialog"])
    );
    expect(Object.keys(extend.spacing)).toEqual(
      expect.arrayContaining(["gutter", "card", "control"])
    );
    expect(Object.keys(extend.transitionDuration)).toEqual(["fast", "base", "slow"]);
    expect(Object.keys(extend.transitionTimingFunction)).toEqual(["standard"]);
  });

  test("every variable the config references is defined in globals.css", () => {
    const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
    const used = flatten(extend).flatMap((v) =>
      [...v.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1])
    );
    const external = /^(font-|radix-)/;
    const own = used.filter((name) => !external.test(name));
    expect(own.length).toBeGreaterThan(0);
    for (const name of own) expect(defined.has(name)).toBe(true);
  });
});
