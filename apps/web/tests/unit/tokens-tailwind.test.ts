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

  test("every color role supports opacity modifiers", () => {
    const values = flatten(colors);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toContain("<alpha-value>");
  });

  test("color role keys are the token layer and nothing else", () => {
    expect(Object.keys(colors).sort()).toEqual(
      [
        "accent",
        "canvas",
        "danger",
        "edge",
        "fg",
        "focus",
        "line",
        "stellar",
        "success",
        "surface",
        "value",
        "warning",
      ].sort()
    );
  });

  test("stellar is an alias of accent, not a second value", () => {
    expect(colors.stellar).toBe("hsl(var(--accent) / <alpha-value>)");
  });

  test("danger registers the fill and the text pair", () => {
    expect(colors.danger).toEqual({
      DEFAULT: "hsl(var(--danger) / <alpha-value>)",
      fg: "hsl(var(--danger-fg) / <alpha-value>)",
      "on-fill": "hsl(var(--danger-on-fill) / <alpha-value>)",
    });
  });

  test("the product is dark only", () => {
    expect(config.darkMode).toBeUndefined();
  });

  test("radius keys keep their values", () => {
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
