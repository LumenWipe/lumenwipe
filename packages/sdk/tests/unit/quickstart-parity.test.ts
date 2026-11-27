import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** The member names of the `expected: { ... }` object literal, spreads by the function spread. */
function expectedKeys(source: string): string[] {
  const start = source.indexOf("expected: {");
  if (start < 0) throw new Error("no expected object");
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(source.indexOf("{", start) + 1, end);
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^ {4,}(\.\.\.)?([A-Za-z]+)/.exec(line);
    if (match && !/^ {10,}/.test(line)) keys.push(match[2]);
  }
  return keys.sort();
}

describe("the quickstart's verifier call", () => {
  const page = read("docs/integrators/quickstart.mdx");

  test("passes the same expectations as the example the nightly run signs with", () => {
    const example = read("packages/sdk/examples/verify.ts");
    expect(expectedKeys(page)).toEqual(expectedKeys(example));
  });

  test("passes the pool half of the expectation", () => {
    expect(expectedKeys(page)).toContain("poolWithdrawals");
  });

  test("the script the nightly run extracts is in the page", () => {
    expect(page).toMatch(/^```js close\.mjs$/m);
  });
});

test("the extracted key list is the whole expectation, not an empty match", () => {
  const keys = expectedKeys(read("docs/integrators/quickstart.mdx"));
  expect(keys).toEqual(
    [
      "source",
      "destination",
      "nativeBalance",
      "memo",
      "memoType",
      "claimTrustlineAssets",
      "accountSigners",
      "accountThresholds",
      "transfers",
      "tokenTransfers",
      "classicConversions",
      "tokenConversions",
      "sponsoredEntries",
      "exitExpectations",
      "poolWithdrawals",
    ].sort()
  );
});
