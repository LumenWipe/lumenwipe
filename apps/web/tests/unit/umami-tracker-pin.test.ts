import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UMAMI_SCRIPT } from "@/config/marketing-csp.mjs";

const PUBLIC = join(import.meta.dir, "..", "..", "public");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// Any edit to the vendored tracker changes these pins, so it cannot pass review unnoticed. To
// update it, follow "Updating the pinned Umami tracker" in docs/reference/logging-and-privacy.mdx.
const PINNED = "768ab7ae5fdafc5c2f77c152676e9f8896f0748b26e9fb046a89782e1a388155";
const UPSTREAM = "77c63c2d59d15b0ae0a694870804cd5d88ba2d0333d90ba1f3c81ff750aa90f3";

test("the pinned Umami tracker is exactly the reviewed copy, named by its own hash", () => {
  const bytes = readFileSync(join(PUBLIC, UMAMI_SCRIPT));
  expect(sha256(bytes)).toBe(PINNED);
  expect(UMAMI_SCRIPT).toBe(`/a/u-${PINNED.slice(0, 12)}.js`);
});

test("below its license comment, the tracker is Umami's script unchanged, sending to the collector", () => {
  const text = readFileSync(join(PUBLIC, UMAMI_SCRIPT), "utf8");
  const [header, ...rest] = text.split("\n");
  const upstream = rest.join("\n");
  expect(header).toStartWith("/*! Umami tracker");
  expect(header).toContain(`sha256 ${UPSTREAM}`);
  expect(header).toContain("MIT License");
  expect(sha256(upstream)).toBe(UPSTREAM);
  expect([...new Set(upstream.match(/https:\/\/[a-z0-9.-]+/g))].sort()).toEqual([
    "https://gateway.umami.is",
    "https://localhost",
  ]);
});

test("the vendored directory holds only the pinned tracker and its license", () => {
  expect(readdirSync(join(PUBLIC, "a")).sort()).toEqual(["LICENSE.txt", UMAMI_SCRIPT.slice(3)]);
  const license = readFileSync(join(PUBLIC, "a", "LICENSE.txt"), "utf8");
  expect(license).toContain(UMAMI_SCRIPT.slice(3));
  expect(license).toContain("Copyright (c) 2022 Umami Software, Inc.");
  expect(license).toContain("Permission is hereby granted, free of charge");
});
