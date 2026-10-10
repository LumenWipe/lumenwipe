import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

const root = process.cwd();
const BANNED = /(?<![\w-])(?:[a-z-]+:)*text-white\/(?:[0-4]\d|5[0-5]|\d)(?![\w/[-])/g;

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return /\.(tsx|ts)$/.test(entry.name) ? [rel] : [];
  });
}

describe("text color guard", () => {
  test("matcher flags dim white text and spares the rest", () => {
    const flagged = [
      "text-white/20",
      "placeholder:text-white/30",
      "hover:text-white/55",
      "text-white/5",
    ];
    const spared = [
      "text-white/60",
      "text-white/85",
      "text-fg-subtle",
      "border-white/15",
      "bg-white/[0.03]",
    ];
    for (const c of flagged) expect(c.match(BANNED)).not.toBeNull();
    for (const c of spared) expect(c.match(BANNED)).toBeNull();
  });

  test("no app or component source uses white opacity text at or below 55", () => {
    const offenders = ["app", "components"].flatMap(walk).flatMap((rel) => {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      return [...src.matchAll(BANNED)].map((m) => `${rel}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
