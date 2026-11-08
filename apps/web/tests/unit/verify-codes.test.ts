/**
 * The refusal codes, read from the verifier's source. Every `new VerificationError(` names its
 * code as a literal from the one registry, every registered code is thrown somewhere, and the
 * codes are unique snake_case. The type-check already rejects a code outside the union; this pins
 * what it cannot: the number of refusal sites, a code nothing throws, and a computed code.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERIFICATION_ERROR_CODES } from "@/lib/stellar/verification-error";

const read = (path: string): string =>
  readFileSync(new URL(`../../lib/stellar/${path}`, import.meta.url), "utf8");

/** Each file that constructs a VerificationError, with how many refusal sites it holds. */
const SOURCES: [string, number][] = [
  ["verify.ts", 101],
  ["intent/serialize.ts", 1],
];

const CONSTRUCTION = /new VerificationError\(/g;
const CODED_CONSTRUCTION = /new VerificationError\(\s*"([a-z_]+)",/g;

const thrown = SOURCES.flatMap(([path]) =>
  [...read(path).matchAll(CODED_CONSTRUCTION)].map((match) => match[1]!)
);

describe("refusal sites", () => {
  test("no other file under lib/stellar constructs a VerificationError", () => {
    const root = new URL("../../lib/stellar/", import.meta.url).pathname;
    const constructing = [...new Bun.Glob("**/*.ts").scanSync(root)]
      .filter((path) => read(path).includes("new VerificationError("))
      .sort();
    expect(constructing).toEqual(SOURCES.map(([path]) => path).sort());
  });

  for (const [path, sites] of SOURCES) {
    test(`${path} has ${sites} refusal sites, each naming its code as a literal`, () => {
      const source = read(path);
      expect(source.match(CONSTRUCTION)?.length).toBe(sites);
      expect([...source.matchAll(CODED_CONSTRUCTION)].length).toBe(sites);
    });
  }

  test("every code thrown is registered", () => {
    const registered = new Set<string>(VERIFICATION_ERROR_CODES);
    expect(thrown.filter((code) => !registered.has(code))).toEqual([]);
  });

  test("every registered code is thrown somewhere", () => {
    const used = new Set(thrown);
    expect(VERIFICATION_ERROR_CODES.filter((code) => !used.has(code))).toEqual([]);
  });
});

describe("the registry", () => {
  test("holds each code once", () => {
    expect(new Set(VERIFICATION_ERROR_CODES).size).toBe(VERIFICATION_ERROR_CODES.length);
  });

  test("spells every code in lower snake_case", () => {
    for (const code of VERIFICATION_ERROR_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });
});
