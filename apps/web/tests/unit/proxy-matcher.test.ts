import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getAllSlugs } from "@/lib/blog";

const MARKETING_DIR = join(process.cwd(), "app", "(marketing)");

/** Every marketing page path, from the files under app/(marketing) and the published posts. */
function marketingPaths(): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "page.tsx")
        pages.push(relative(MARKETING_DIR, dir).split(sep).join("/"));
    }
  };
  walk(MARKETING_DIR);
  return pages.flatMap((route) =>
    route.includes("[slug]")
      ? getAllSlugs().map((slug) => `/${route.replace("[slug]", slug)}`)
      : [`/${route}`.replace(/\/$/, "") || "/"]
  );
}

// The regexes Next compiles from proxy.ts's matcher, with the function the build itself uses.
// Computed in a child process: Next's build modules leave global state that breaks other suites.
const COMPILE = `
globalThis.AsyncLocalStorage = (await import("node:async_hooks")).AsyncLocalStorage;
const { config } = await import("./proxy.ts");
const { getMiddlewareMatchers } = await import("next/dist/build/analysis/get-page-static-info");
console.log(JSON.stringify(getMiddlewareMatchers(config.matcher, {}).map((m) => m.regexp)));
`;
const child = Bun.spawnSync([process.execPath, "-e", COMPILE], { cwd: process.cwd() });
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const MATCHERS = (JSON.parse(child.stdout.toString()) as string[]).map((r) => new RegExp(r));
const runsProxy = (path: string) => MATCHERS.some((regexp) => regexp.test(path));

describe("the proxy matcher", () => {
  const paths = marketingPaths();

  test("finds the marketing pages and every published post", () => {
    expect(paths).toContain("/");
    expect(paths).toContain("/faq");
    expect(paths.filter((p) => p.startsWith("/blog/"))).toHaveLength(getAllSlugs().length);
  });

  test("skips every prerendered marketing page and its RSC payload, so a new post needs its line", () => {
    for (const path of paths) {
      expect(runsProxy(path), path).toBe(false);
      expect(runsProxy(path === "/" ? "/index.rsc" : `${path}.rsc`), `${path}.rsc`).toBe(false);
    }
  });

  test("skips the prerendered blog feed", () => {
    expect(runsProxy("/blog/feed.xml")).toBe(false);
    expect(runsProxy("/blog/feedxxml")).toBe(true);
    expect(runsProxy("/blog/feed.xml/x")).toBe(true);
  });

  test("still runs for the network and sign-in routes, any unknown path and the API", () => {
    for (const path of [
      "/mainnet",
      "/testnet/analyze",
      "/mainnet/receipt/abc",
      "/cosign",
      "/api-keys",
      "/blog/no-such-post",
      "/blog/account-merge-on-stellar/extra",
      "/faqx",
      "/index",
      "/faq/x",
      "/x/y/z",
      "/api/health",
      "/api/mainnet/paths",
    ]) {
      expect(runsProxy(path), path).toBe(true);
    }
  });
});
