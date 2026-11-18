import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");

// The root document loads next/font, which runs only inside a Next build, so its source is read.
test("the root document loads no third-party script", () => {
  for (const file of [
    ["app", "root-document.tsx"],
    ["components", "analytics", "RedactedAnalytics.tsx"],
  ]) {
    const source = readFileSync(join(WEB, ...file), "utf8");
    expect(source, file.join("/")).not.toMatch(/<script\b|next\/script/i);
    expect(source, file.join("/")).not.toMatch(/umami/i);
  }
});
