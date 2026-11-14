import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_ORDER } from "@/lib/scene-model";

// Axe checks text contrast only. A node's border and icon are what tell its kind and its edge, so
// WCAG 1.4.11 asks 3:1 of them against what they sit on: the node's own fill, the panel and the
// page. Read from the stylesheet the browser gets.

const css = readFileSync(join(import.meta.dir, "../../app/globals.css"), "utf8");

function token(name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%;`).exec(css);
  if (!match) throw new Error(`no --${name} token in globals.css`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([h, s, l]: [number, number, number]): number {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

const ratio = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("the contrast helper matches the WCAG figure for white on black", () => {
  expect(ratio([0, 0, 100], [0, 0, 0])).toBeCloseTo(21);
});

test("every kind colour reaches 3:1 on the node fill, the panel and the page", () => {
  const grounds = ["scene-node", "mkt-panel", "background"].map(token);
  for (const kind of KIND_ORDER) {
    const colour = token(`kind-${kind}`);
    for (const ground of grounds) {
      expect({ kind, ratio: ratio(colour, ground) >= 3 }).toEqual({ kind, ratio: true });
    }
  }
});
