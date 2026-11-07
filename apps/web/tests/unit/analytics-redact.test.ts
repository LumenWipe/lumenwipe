import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  redactEvent,
  redactUrl,
  UMAMI_BEFORE_SEND,
  UMAMI_BEFORE_SEND_SCRIPT,
} from "@/lib/analytics/redact";

const ORIGIN = "https://lumenwipe.com";
const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

test("a receipt's id never reaches analytics", () => {
  expect(redactUrl(`${ORIGIN}/testnet/receipt/0f8e2c1a-1111-4222-8333-944445555666`)).toBe(
    `${ORIGIN}/testnet/receipt/[id]`
  );
  expect(redactUrl(`/mainnet/receipt/abc?x=1#top`)).toBe("/mainnet/receipt/[id]");
});

test("the query and fragment are dropped from every address, with any account in them", () => {
  expect(redactUrl(`${ORIGIN}/testnet/analyze?source=${ADDRESS}`)).toBe(
    `${ORIGIN}/testnet/analyze`
  );
  expect(redactUrl(`${ORIGIN}/testnet/allowances?address=${ADDRESS}&x=1`)).toBe(
    `${ORIGIN}/testnet/allowances`
  );
  expect(redactUrl(`${ORIGIN}/blog/post#${ADDRESS}`)).toBe(`${ORIGIN}/blog/post`);
});

test("an address with nothing private is reported as is", () => {
  expect(redactUrl(`${ORIGIN}/testnet/review`)).toBe(`${ORIGIN}/testnet/review`);
  expect(redactUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/`);
});

test("the event keeps its type and is redacted", () => {
  expect(
    redactEvent({ type: "pageview", url: `${ORIGIN}/testnet/receipt/r1?source=${ADDRESS}` })
  ).toEqual({ type: "pageview", url: `${ORIGIN}/testnet/receipt/[id]` });
  const custom = redactEvent({ type: "event", url: `${ORIGIN}/testnet?address=${ADDRESS}` });
  expect(JSON.stringify(custom)).not.toContain(ADDRESS);
});

/** Runs the inline script the layout ships for Umami and returns the hook it defines. */
function umamiHook(): (type: string, payload: unknown) => Record<string, unknown> | null {
  const win: Record<string, unknown> = {};
  new Function("window", UMAMI_BEFORE_SEND_SCRIPT)(win);
  return win[UMAMI_BEFORE_SEND] as never;
}

test("the Umami hook redacts the page and the referrer the same way", () => {
  const hook = umamiHook();
  const receipt = `${ORIGIN}/testnet/receipt/0f8e2c1a?source=${ADDRESS}#x`;
  const analyze = `${ORIGIN}/testnet/analyze?source=${ADDRESS}`;
  expect(hook("event", { url: receipt, referrer: analyze, title: "Receipt" })).toEqual({
    url: redactUrl(receipt),
    referrer: redactUrl(analyze),
    title: "Receipt",
  });
  expect(hook("event", { url: "/mainnet/receipt/r1", referrer: "" })).toEqual({
    url: "/mainnet/receipt/[id]",
    referrer: "",
  });
  expect(hook("event", null)).toBeNull();
});

test("the layout defines the Umami hook before Umami loads, and has it drop queries and fragments", () => {
  const layout = readFileSync(join(import.meta.dir, "..", "..", "app", "layout.tsx"), "utf8");
  const hook = layout.indexOf("__html: UMAMI_BEFORE_SEND_SCRIPT");
  const umami = layout.indexOf('src="https://cloud.umami.is/script.js"');
  expect(hook).toBeGreaterThan(-1);
  expect(umami).toBeGreaterThan(hook);
  const tag = layout.slice(umami, layout.indexOf("/>", umami));
  expect(tag).toContain('data-exclude-search="true"');
  expect(tag).toContain('data-exclude-hash="true"');
  expect(tag).toContain("data-before-send={UMAMI_BEFORE_SEND}");
});
