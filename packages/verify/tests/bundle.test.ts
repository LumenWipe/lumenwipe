/**
 * What the built bundle may contain. The verifier must run the same in a browser, a worker and a
 * server, so it reads no network, no page and no environment; and it must not carry its own copy
 * of the Stellar SDK, which would decode XDR with a version nobody pinned.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const read = (file: string): string =>
  readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");

const bundles: [string, string, RegExp][] = [
  ["index.js", read("index.js"), /from ['"]@stellar\/stellar-sdk['"]/],
  ["index.cjs", read("index.cjs"), /require\(['"]@stellar\/stellar-sdk['"]\)/],
];

const FORBIDDEN: [string, RegExp][] = [
  ["a network call", /\bfetch\s*\(/],
  ["the page's window", /\bwindow\b/],
  ["the page's document", /\bdocument\b/],
  ["the process environment", /\bprocess\.env\b/],
  ["the served registry route", /\/api\/config\/exchange-registry/],
];

/** Code that exists only inside the Stellar SDK and its XDR runtime. */
const SDK_INTERNALS: RegExp[] = [
  /class TransactionBuilder\b/,
  /TransactionBuilder = class\b/,
  /class StrKey\b/,
  /\bLargeInt\b/,
];

for (const [file, source, sdkImport] of bundles) {
  describe(`dist/${file}`, () => {
    for (const [what, pattern] of FORBIDDEN) {
      test(`does not reach ${what}`, () => {
        expect(source).not.toMatch(pattern);
      });
    }

    test("imports the Stellar SDK as a peer instead of inlining it", () => {
      expect(source).toMatch(sdkImport);
      for (const internal of SDK_INTERNALS) expect(source).not.toMatch(internal);
    });
  });
}

test("exports exactly the documented surface, in both formats", async () => {
  const surface = [
    "VerificationError",
    "exitExpectations",
    "requiresMediator",
    "verifyCloseTransaction",
  ];
  const esm = await import(new URL("../dist/index.js", import.meta.url).href);
  const cjs = createRequire(import.meta.url)(
    new URL("../dist/index.cjs", import.meta.url).pathname
  );
  expect(Object.keys(esm).sort()).toEqual(surface);
  expect(Object.keys(cjs).sort()).toEqual(surface);
});

test("requiresMediator answers from the bundled exchange registry, in both formats", async () => {
  const listed = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";
  const unlisted = "GBTEQW2LDRZGL6OXSF6KCYWIDE4J24RNHYIVCSVXABY6KDWJTVAAG6HD";
  const esm = await import(new URL("../dist/index.js", import.meta.url).href);
  const cjs = createRequire(import.meta.url)(
    new URL("../dist/index.cjs", import.meta.url).pathname
  );
  for (const mod of [esm, cjs]) {
    expect(mod.requiresMediator(listed)).toBe(true);
    expect(mod.requiresMediator(unlisted)).toBe(false);
  }
});
