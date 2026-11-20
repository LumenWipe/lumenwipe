import { expect, test } from "bun:test";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { HOMEPAGE_LINK } from "@/config/discovery-links.mjs";
import {
  SECURITY_HEADERS,
  SIGNING_HEADER_RULES,
  SIGNING_PERMISSIONS_POLICY,
} from "@/config/security-headers.mjs";
import config from "@/next.config.mjs";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

const header = (key: string): string | undefined =>
  SECURITY_HEADERS.find((h) => h.key === key)?.value;

test("security-headers › every route, /api included, carries the full set", async () => {
  const rules = await config(PHASE_PRODUCTION_SERVER).headers!();
  expect(rules).toEqual([
    { source: "/:path*", headers: [...SECURITY_HEADERS] },
    ...SIGNING_HEADER_RULES,
    { source: "/", headers: [{ key: "Link", value: HOMEPAGE_LINK }] },
  ]);
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

const policyEntries = (policy: string): Map<string, string> =>
  new Map(policy.split(", ").map((entry) => entry.split("=") as [string, string]));

const REFUSED = [
  "camera",
  "microphone",
  "geolocation",
  "payment",
  "hid",
  "serial",
  "bluetooth",
  "midi",
  "display-capture",
  "clipboard-read",
  "publickey-credentials-create",
  "publickey-credentials-get",
];

test("security-headers › Permissions-Policy allows only clipboard writes and the embed's fullscreen", () => {
  const policy = policyEntries(header("Permissions-Policy")!);
  const embed = '(self "https://www.youtube-nocookie.com")';
  expect(policy.get("clipboard-write")).toBe(embed);
  expect(policy.get("fullscreen")).toBe(embed);
  for (const denied of [...REFUSED, "usb"]) expect(policy.get(denied)).toBe("()");
  expect(policy.size).toBe(15);
});

test("security-headers › the signing policy differs only in WebUSB, opened to this origin", () => {
  const base = policyEntries(header("Permissions-Policy")!);
  const signing = policyEntries(SIGNING_PERMISSIONS_POLICY);
  expect(signing.get("usb")).toBe("(self)");
  expect(signing.get("hid")).toBe("()");
  expect([...signing].filter(([k, v]) => base.get(k) !== v)).toEqual([["usb", "(self)"]]);
});

/** The Permissions-Policy a path ends up with: the last header rule that matches and sets it. */
async function permissionsPolicyFor(path: string): Promise<string[]> {
  const rules = await config(PHASE_PRODUCTION_SERVER).headers!();
  const matching = rules.filter((rule) => getPathMatch(rule.source)(path) !== false);
  const values = matching.flatMap((rule) =>
    rule.headers.filter((h) => h.key === "Permissions-Policy").map((h) => h.value)
  );
  return values.slice(-1);
}

const SIGNING_PATHS = [
  "/mainnet",
  "/testnet",
  "/mainnet/",
  "/mainnet/analyze",
  "/testnet/review",
  "/mainnet/execute",
  "/testnet/allowances",
  "/mainnet/complete",
  "/mainnet/receipt/abc",
  "/cosign",
];

const OTHER_PATHS = [
  "/",
  "/faq",
  "/security",
  "/blog",
  "/blog/phase-2-launch",
  "/es",
  "/es/faq",
  "/api-keys",
  "/api/v1/health",
  "/public",
  "/mainnetx",
  "/mainnet.rsc",
  "/x/mainnet",
  "/cosign/extra",
  "/cosignx",
  "/playground",
];

test("security-headers › WebUSB is allowed on every route that signs", async () => {
  for (const path of SIGNING_PATHS) {
    expect(await permissionsPolicyFor(path), path).toEqual([SIGNING_PERMISSIONS_POLICY]);
  }
});

test("security-headers › no other route gets WebUSB", async () => {
  for (const path of OTHER_PATHS) {
    expect(await permissionsPolicyFor(path), path).toEqual([header("Permissions-Policy")!]);
  }
});

test("security-headers › only the signing rules ever send usb=(self)", async () => {
  const rules = await config(PHASE_PRODUCTION_SERVER).headers!();
  const opened = rules
    .filter((rule) => rule.headers.some((h) => h.value.includes("usb=(self)")))
    .map((rule) => rule.source);
  expect(opened).toEqual(["/:network(mainnet|testnet)/:path*", "/cosign"]);
});

test("security-headers › the homepage alone links the API catalog, the docs and llms.txt", () => {
  expect(HOMEPAGE_LINK).toBe(
    '<https://api.lumenwipe.com/.well-known/api-catalog>; rel="api-catalog", ' +
      '<https://docs.lumenwipe.com>; rel="service-doc", ' +
      '</llms.txt>; rel="describedby"; type="text/plain"'
  );
});
