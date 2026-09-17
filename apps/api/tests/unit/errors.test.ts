/**
 * `describeError` (lib/utils/errors.ts): whatever was thrown, rendered as something a person can
 * read. The Soroban RPC client and several SDKs reject with plain objects rather than `Error`s,
 * and those end up inside user-facing warnings.
 */
import { describe, expect, test } from "bun:test";
import { describeError } from "@/lib/utils/errors";

describe("describeError", () => {
  test("an Error is its message", () => {
    expect(describeError(new Error("socket hang up"))).toBe("socket hang up");
  });

  test("a JSON-RPC rejection reads as a sentence, not as [object Object]", () => {
    // The Soroban RPC client rejects with a plain object, so `String(e)` produced the literal
    // text "[object Object]" - which reached users inside warnings about an incomplete scan.
    expect(
      describeError({ code: -32001, message: "request exceeded processing limit threshold" })
    ).toBe("[-32001] request exceeded processing limit threshold");
  });

  test("other shapes of error object still say something", () => {
    expect(describeError({ title: "No path found", detail: "No path found" })).toBe(
      "No path found"
    );
    expect(describeError({ error: "Quote Failed" })).toBe("Quote Failed");
    expect(describeError("plain string")).toBe("plain string");
  });

  test("an object with nothing readable falls back to its JSON, never to [object Object]", () => {
    expect(describeError({ weird: true, nested: { a: 1 } })).toBe(
      '{"weird":true,"nested":{"a":1}}'
    );
    expect(describeError({})).not.toContain("[object");
  });
});
