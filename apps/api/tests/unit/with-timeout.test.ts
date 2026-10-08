import { expect, test } from "bun:test";
import { withTimeout } from "@/lib/utils/with-timeout";

test("resolves with the promise's value when it finishes first", async () => {
  const result = await withTimeout(Promise.resolve("done"), 50, "timed out");
  expect(result).toBe("done");
});

test("rejects with the timeout message when the promise takes too long", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
  await expect(withTimeout(slow, 20, "timed out after 20ms")).rejects.toThrow(
    "timed out after 20ms"
  );
});
