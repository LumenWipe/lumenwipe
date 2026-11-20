import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = join(import.meta.dir, "..", "..");

// The layouts load next/font, which runs only inside a Next build, so their source is read.
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

function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(tsx?|mjs)$/.test(file))
    .map((file) => relative(WEB, join(WEB, dir, file)));
}

// A root layout wraps only its own route group, so Umami mounted from the two marketing root
// layouts alone can never render on an app, sign-in or 404 route.
test("only the marketing root layouts mount Umami", () => {
  const importers = ["app", "components", "lib", "hooks", "store"]
    .flatMap(sources)
    .filter((file) => /analytics\/UmamiAnalytics["']/.test(readFileSync(join(WEB, file), "utf8")))
    .sort();
  expect(importers).toEqual(["app/(marketing)/layout.tsx", "app/(marketing-es)/layout.tsx"]);
  for (const file of [
    "app/(app)/layout.tsx",
    "app/global-not-found.tsx",
    "components/marketing/MarketingShell.tsx",
    ...sources("app/(app)"),
  ]) {
    expect(readFileSync(join(WEB, file), "utf8"), file).not.toMatch(/umami/i);
  }
});
