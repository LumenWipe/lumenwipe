import { afterEach, expect, test } from "bun:test";
import { commitUrl, deployedCommit, shortCommit } from "@/lib/site/build-info";
import { REPO_URL } from "@/lib/site/trust";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const saved = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
  if (saved === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = saved;
});

test("the deployed commit is the full hash Vercel sets at build time", () => {
  process.env.VERCEL_GIT_COMMIT_SHA = SHA;
  expect(deployedCommit()).toBe(SHA);
  expect(commitUrl(SHA)).toBe(`${REPO_URL}/commit/${SHA}`);
  expect(shortCommit(SHA)).toBe("0123456");
});

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["short", "0123456"],
  ["uppercase", SHA.toUpperCase()],
  ["one character too long", `${SHA}0`],
  ["a path", `${SHA.slice(0, 39)}/`],
  ["a URL", "javascript:alert(1)"],
])("a value that is %s is no commit", (_name, value) => {
  if (value === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = value;
  expect(deployedCommit()).toBeNull();
});
