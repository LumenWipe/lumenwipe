import { describe, expect, test } from "bun:test";
import { missingRequiredMemoError } from "@/lib/plan/memo-requirement";

describe("missingRequiredMemoError", () => {
  test("stops a destination that requires a memo when none was entered", () => {
    expect(missingRequiredMemoError({ requiresMemo: true }, "")).toContain("needs a memo");
    expect(missingRequiredMemoError({ requiresMemo: true }, "   ")).toContain("needs a memo");
  });

  test("lets a destination through once a memo is entered or when none is required", () => {
    expect(missingRequiredMemoError({ requiresMemo: true }, "4411")).toBeNull();
    expect(missingRequiredMemoError({ requiresMemo: false }, "")).toBeNull();
  });
});
