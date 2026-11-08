import { expect, test } from "bun:test";

// Bun runs the tests of a file in the order they are declared, so the second test sees whatever
// document the first one left behind, after the shared setup in tests/setup-dom.ts has run.

test("a test may leave a title behind on the shared document", () => {
  document.title = "Close incomplete | LumenWipe";
  expect(document.title).toBe("Close incomplete | LumenWipe");
});

test("the next test starts with no title, so a stale one cannot satisfy its check", () => {
  expect(document.title).toBe("");
});
