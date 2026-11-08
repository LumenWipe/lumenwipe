import { expect, test } from "bun:test";
import { withoutTrailingSlashes } from "../../src/url";

test("trims one and many trailing slashes and leaves inner slashes", () => {
  expect(withoutTrailingSlashes("https://api.test/")).toBe("https://api.test");
  expect(withoutTrailingSlashes("https://api.test/base///")).toBe("https://api.test/base");
  expect(withoutTrailingSlashes("https://api.test/a/b")).toBe("https://api.test/a/b");
  expect(withoutTrailingSlashes("///")).toBe("");
  expect(withoutTrailingSlashes("")).toBe("");
});

test("a 100k-slash input returns quickly", () => {
  const input = `https://api.test${"/".repeat(100_000)}x${"/".repeat(100_000)}`;
  const started = performance.now();
  expect(withoutTrailingSlashes(input)).toBe(`https://api.test${"/".repeat(100_000)}x`);
  expect(withoutTrailingSlashes("/".repeat(100_000))).toBe("");
  expect(performance.now() - started).toBeLessThan(100);
});
