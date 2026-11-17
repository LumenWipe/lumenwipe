import { describe, expect, test } from "bun:test";
import config from "../../tailwind.config";
import { cn } from "@/lib/utils/cn";

const sizes = Object.keys(config.theme?.extend?.fontSize ?? {});

describe("cn with the type scale", () => {
  test("reads a non-empty scale from the Tailwind config", () => {
    expect(sizes.length).toBeGreaterThan(0);
  });

  for (const size of sizes) {
    test(`text-${size} survives a text color on either side`, () => {
      expect(cn(`text-${size}`, "text-fg-subtle")).toBe(`text-${size} text-fg-subtle`);
      expect(cn("text-fg-subtle", `text-${size}`)).toBe(`text-fg-subtle text-${size}`);
    });

    test(`text-${size} replaces an earlier font size`, () => {
      expect(cn("text-sm", `text-${size}`)).toBe(`text-${size}`);
      expect(cn(`text-${size}`, "text-xs")).toBe("text-xs");
    });
  }
});
