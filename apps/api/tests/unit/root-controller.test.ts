import { afterEach, expect, test } from "bun:test";
import { RootController } from "../../src/root.controller";

const original = process.env.GIT_SHA;

afterEach(() => {
  if (original === undefined) delete process.env.GIT_SHA;
  else process.env.GIT_SHA = original;
});

test("reports the commit the image was built from", () => {
  process.env.GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
  expect(new RootController().index().gitSha).toBe("0123456789abcdef0123456789abcdef01234567");
});

test("reports null when the image was built without a commit", () => {
  for (const value of [undefined, ""]) {
    if (value === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = value;
    expect(new RootController().index().gitSha).toBeNull();
  }
});
