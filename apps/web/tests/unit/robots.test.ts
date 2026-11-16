import { expect, test } from "bun:test";
import robots from "@/app/robots";

test("robots › every crawler may crawl, and the content signals refuse training only", () => {
  expect(robots().rules).toEqual({
    userAgent: "*",
    allow: "/",
    other: { "Content-Signal": "ai-train=no, search=yes, ai-input=yes" },
  });
});
