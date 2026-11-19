import { describe, expect, test } from "bun:test";
import { VALID_NETWORKS } from "@/config/networks";

// The rewrites next.config.mjs declares, compiled with the function the build itself uses.
// Computed in a child process: Next's build modules leave global state that breaks other suites.
const COMPILE = `
const { default: config } = await import("./next.config.mjs");
const { buildCustomRoute } = await import("next/dist/lib/build-custom-route.js");
const rewrites = await config("phase-test").rewrites();
console.log(JSON.stringify({
  beforeFiles: rewrites.beforeFiles ?? [],
  fallback: rewrites.fallback ?? [],
  afterFiles: rewrites.afterFiles.map((r) => ({ ...r, regex: buildCustomRoute("rewrite", r).regex })),
}));
`;
const child = Bun.spawnSync([process.execPath, "-e", COMPILE], { cwd: process.cwd() });
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const REWRITES = JSON.parse(child.stdout.toString()) as {
  beforeFiles: unknown[];
  fallback: unknown[];
  afterFiles: { source: string; destination: string; regex: string }[];
};

const RULE = REWRITES.afterFiles.find((r) => r.destination === "/_not-found");

/** The rule as Next's own server matches it. */
const anchored = () => new RegExp(RULE!.regex);

/** The rule as the Vercel adapter emits it: its trailing `$` replaced by an optional RSC suffix,
 *  so the route matches any path it is a prefix of. */
const adapted = () =>
  new RegExp(`${RULE!.regex.replace(/\$$/, "")}(?<rscsuff>\\.rsc|\\.segments/.+\\.segment\\.rsc)?`);

const UNKNOWN_SEGMENTS = ["/nope", "/foo", "/esx", "/api", "/nope.rsc", "/testnetx", "/mainnetx"];

const ROUTED = [
  "/testnet",
  "/mainnet",
  "/testnet.rsc",
  "/mainnet.rsc",
  "/testnet/analyze",
  "/mainnet/receipt/abc",
  "/testnet.segments/_tree.segment.rsc",
  "/nope/analyze",
  "/x/y/z",
  "/api/testnet/estimate",
  "/api/v1/testnet/submit",
  "/api/integrator/keys/abc/revoke",
  "/blog/account-merge-on-stellar",
  "/blog/account-merge-on-stellar/share.png",
  "/es/nope",
];

describe("the unknown single-segment rewrite", () => {
  test("is the only rewrite, applied after the filesystem and before the dynamic routes", () => {
    expect(REWRITES.beforeFiles).toEqual([]);
    expect(REWRITES.fallback).toEqual([]);
    expect(REWRITES.afterFiles).toHaveLength(1);
    expect(RULE).toBeDefined();
  });

  for (const [name, compile] of [
    ["as next start matches it", anchored],
    ["as the Vercel adapter emits it", adapted],
  ] as const) {
    test(`sends a single unknown segment to the global 404 ${name}`, () => {
      for (const path of UNKNOWN_SEGMENTS) expect(compile().test(path), path).toBe(true);
    });

    test(`leaves every network, its RSC payload and every deeper path alone ${name}`, () => {
      for (const path of ROUTED) expect(compile().test(path), path).toBe(false);
    });

    test(`excludes exactly the networks the app validates ${name}`, () => {
      for (const network of VALID_NETWORKS) {
        expect(compile().test(`/${network}`), network).toBe(false);
        expect(compile().test(`/${network}.rsc`), `${network}.rsc`).toBe(false);
      }
    });
  }
});
