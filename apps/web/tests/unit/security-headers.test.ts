import { expect, test } from "bun:test";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { SECURITY_HEADERS } from "@/config/security-headers.mjs";
import config from "@/next.config.mjs";

const header = (key: string): string | undefined =>
  SECURITY_HEADERS.find((h) => h.key === key)?.value;

test("security-headers › every route, /api included, carries the full set", async () => {
  const rules = await config(PHASE_PRODUCTION_SERVER).headers!();
  expect(rules).toEqual([{ source: "/:path*", headers: [...SECURITY_HEADERS] }]);
  expect(SECURITY_HEADERS.map((h) => h.key)).toEqual([
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Reporting-Endpoints",
  ]);
});

test("security-headers › HSTS covers subdomains for two years and is not preloaded", () => {
  expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
});

test("security-headers › nosniff and an origin-only referrer for other origins", () => {
  expect(header("X-Content-Type-Options")).toBe("nosniff");
  expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
});

test("security-headers › COOP keeps the opener for wallet popups (Albedo, xBull web)", () => {
  expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
});

test("security-headers › CSP reports go to the receiver route", () => {
  expect(header("Reporting-Endpoints")).toBe('csp="/api/csp-report"');
});

test("security-headers › Permissions-Policy allows only clipboard writes and the embed's fullscreen", () => {
  const policy = new Map(
    header("Permissions-Policy")!
      .split(", ")
      .map((entry) => entry.split("=") as [string, string])
  );
  const embed = '(self "https://www.youtube-nocookie.com")';
  expect(policy.get("clipboard-write")).toBe(embed);
  expect(policy.get("fullscreen")).toBe(embed);
  for (const denied of [
    "camera",
    "microphone",
    "geolocation",
    "payment",
    "usb",
    "hid",
    "serial",
    "bluetooth",
    "midi",
    "display-capture",
    "clipboard-read",
    "publickey-credentials-create",
    "publickey-credentials-get",
  ]) {
    expect(policy.get(denied)).toBe("()");
  }
  expect(policy.size).toBe(15);
});
