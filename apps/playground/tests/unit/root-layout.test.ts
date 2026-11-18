import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The layout loads next/font, which runs only inside a Next build, so its source is read.
test("the root layout loads no third-party script", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "app", "layout.tsx"), "utf8");
  expect(source).not.toMatch(/<script\b|next\/script/i);
  expect(source).not.toMatch(/umami/i);
});
