import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { HOMEPAGE_LINK } from "../../../config/discovery-links.mjs";
import { SECURITY_HEADERS } from "../../../config/security-headers.mjs";
import {
  pageScripts,
  prerenderedMarketingPages,
  scriptHash,
} from "../../../scripts/marketing-csp.mjs";

// Headers do not depend on the viewport: one project is enough.
test.beforeEach(() => test.skip(test.info().project.name !== "desktop", "viewport-independent"));

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const NEXT_DIR = join(process.cwd(), ".next");

/** Every prerendered marketing page, as the build's own manifests list them. */
const MARKETING = prerenderedMarketingPages(
  readJson(join(NEXT_DIR, "app-path-routes-manifest.json")),
  readJson(join(NEXT_DIR, "prerender-manifest.json"))
);

/** The nonce policy of the app and sign-in routes and of a 404, per path, nonce as NONCE. */
const NONCE_POLICY: Record<string, string> = readJson(
  join(process.cwd(), "tests/unit/fixtures/nonce-csp-golden.json")
);
const NONCE_PATHS = Object.keys(NONCE_POLICY);

function csp(res: APIResponse): string {
  const values = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "content-security-policy")
    .map((h) => h.value);
  expect(values, `${res.url()} sends exactly one Content-Security-Policy`).toHaveLength(1);
  return values[0];
}

for (const path of [...MARKETING, ...NONCE_PATHS, "/api/health"]) {
  test(`${path} carries every security header exactly once`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const raw = res.headersArray();
    for (const { key, value } of SECURITY_HEADERS) {
      const values = raw.filter((h) => h.name.toLowerCase() === key.toLowerCase());
      expect(
        values.map((h) => h.value),
        key
      ).toEqual([value]);
    }
  });
}

test("the app, sign-in and 404 responses keep today's nonce policy byte for byte", async ({
  request,
}) => {
  for (const path of NONCE_PATHS) {
    const res = await request.get(path);
    const policy = csp(res);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
    expect(nonce, path).toBeTruthy();
    expect(policy.replace(`'nonce-${nonce}'`, "'nonce-NONCE'"), path).toBe(NONCE_POLICY[path]);
    expect(res.headers()["cache-control"], path).toContain("no-store");
    const scripts = [...(await res.text()).matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    for (const attrs of scripts.filter((a) => !a.includes('type="application/ld+json"'))) {
      expect(attrs, `${path}: every script carries the response's nonce`).toContain(
        `nonce="${nonce}"`
      );
    }
  }
});

test("every prerendered marketing page is cacheable and hashes exactly the scripts it serves", async ({
  request,
}) => {
  expect(MARKETING).toContain("/");
  for (const path of MARKETING) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const cacheControl = res.headers()["cache-control"] ?? "";
    expect(cacheControl, path).toContain("s-maxage=");
    expect(cacheControl, path).not.toMatch(/private|no-store/);

    const directives = csp(res).split("; ");
    const scriptSrc = directives
      .find((d) => d.startsWith("script-src "))!
      .split(" ")
      .slice(1);
    expect(scriptSrc, path).not.toContain("'unsafe-inline'");
    expect(scriptSrc, path).not.toContain("'unsafe-eval'");
    expect(
      scriptSrc.filter((s) => s.includes("nonce")),
      path
    ).toEqual([]);
    expect(directives, path).toContain("frame-ancestors 'none'");
    expect(directives, path).toContain("object-src 'none'");
    expect(directives.at(-1), path).toBe("report-to csp");

    const hashes = scriptSrc.filter((s) => s.startsWith("'sha256-")).sort();
    const served = [
      ...new Set(
        pageScripts(await res.text()).inline.map((body) => `'sha256-${scriptHash(body)}'`)
      ),
    ].sort();
    expect(served.length, path).toBeGreaterThan(0);
    expect(hashes, path).toEqual(served);
  }
});

test("the homepage alone carries the discovery Link header", async ({ request }) => {
  for (const path of [...MARKETING, ...NONCE_PATHS, "/api/health"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    const links = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "link")
      .map((h) => h.value);
    if (path === "/") expect(links, path).toEqual([HOMEPAGE_LINK]);
    else expect(links.join(", "), path).not.toMatch(/rel="(api-catalog|service-doc|describedby)"/);
  }
});

test("robots.txt carries the content signals in the group for every crawler", async ({
  request,
}) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const group = (await res.text()).split("\n\n")[0]!.split("\n");
  expect(group[0]).toBe("User-Agent: *");
  expect(group).toContain("Content-Signal: ai-train=no, search=yes, ai-input=yes");
});

test("/api gets no CSP", async ({ request }) => {
  const api = await request.get("/api/health");
  expect(api.headers()["content-security-policy"]).toBeUndefined();
});

/** Collects every CSP violation the page reports, from before its first script runs. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) =>
      seen.push(`${e.effectiveDirective} ${e.blockedURI}`)
    );
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}

/** The navigation's own names per `<html lang>`, as `NAV` in lib/i18n/messages/nav.ts gives them. */
const NAV_NAMES = {
  en: { main: "Main", developers: "Developers" },
  "es-419": { main: "Principal", developers: "Desarrolladores" },
} as const;

/** The Developers menu opens only once React has hydrated the marketing navigation. */
async function expectHydrated(page: Page, path: string, lang: keyof typeof NAV_NAMES = "en") {
  const names = NAV_NAMES[lang];
  const developers = page
    .getByRole("navigation", { name: names.main })
    .getByRole("button", { name: names.developers });
  await developers.click();
  await expect(developers, `${path} hydrated`).toHaveAttribute("aria-expanded", "true");
}

for (const [path, lang] of [
  ["/", "en"],
  ["/faq", "en"],
  ["/es/faq", "es-419"],
  ["/registry", "en"],
  ["/blog", "en"],
  ["/blog/account-merge-on-stellar", "en"],
] as const) {
  test(`${path} runs under its hash policy with no violation`, async ({ page }) => {
    const violations = await watchViolations(page);
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expectHydrated(page, path, lang);
    expect(await violations()).toEqual([]);
  });
}

for (const [path, lang, title] of [
  ["/x/y/z", "en", /This page has\s*been closed/],
  ["/mainnet/nope", "en", /This page has\s*been closed/],
  ["/foo", "en", /This page has\s*been closed/],
  ["/blog/nope", "en", /This page has\s*been closed/],
  ["/esx", "en", /This page has\s*been closed/],
  ["/nope", "en", /This page has\s*been closed/],
  ["/es/nope", "es-419", /Esta página\s*ya se cerró/],
  ["/es/x/y", "es-419", /Esta página\s*ya se cerró/],
] as const) {
  test(`${path} answers 404 under the nonce policy, noindex, and hydrates`, async ({ page }) => {
    const violations = await watchViolations(page);
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    expect((await res!.headerValue("content-security-policy")) ?? "").toMatch(
      /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expectHydrated(page, path, lang);
    expect(await violations()).toEqual([]);
  });
}

// A single unknown segment would otherwise reach the [network] segment and fail there with the
// bare error shell, which shows the 404 only after hydration: the server HTML alone carries it.
for (const path of ["/nope", "/foo", "/esx"]) {
  test(`${path} answers the full 404 in its server HTML, under its nonce`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(404);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp(res))?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toMatch(/<html lang="en"[ >]/);
    expect(html).not.toContain('id="__next_error__"');
    expect(html).toContain("<title>404 - Page Not Found</title>");
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(html).toMatch(/<h1\b[^>]*>This page has<br\/>been closed\.<\/h1>/);
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts.filter((a) => !a.includes('type="application/ld+json"'))) {
      expect(attrs, "every script carries the response's nonce").toContain(`nonce="${nonce}"`);
    }
  });
}

test("the report receiver answers 204 and echoes nothing", async ({ request }) => {
  const res = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json" },
    data: JSON.stringify([
      {
        type: "csp-violation",
        body: { effectiveDirective: "img-src", blockedURL: "https://a.example/x" },
      },
    ]),
  });
  expect(res.status()).toBe(204);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.text()).toBe("");
});
