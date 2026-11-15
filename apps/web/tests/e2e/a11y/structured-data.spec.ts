import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { installApiFixtures } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

const POST = readdirSync(join(__dirname, "..", "..", "..", "content", "blog"))
  .filter((f) => f.endsWith(".mdx"))
  .sort()[0]!
  .replace(/\.mdx$/, "");

const PAGES: [string, string[]][] = [
  ["/", ["Organization", "WebSite", "WebApplication"]],
  ["/faq", ["FAQPage"]],
  [`/blog/${POST}`, ["Article", "BreadcrumbList"]],
];

for (const [path, types] of PAGES) {
  test(`${path} serves its structured data as JSON with no CSP violation`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`);
      });
    });

    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? "";
    const blocks = [
      ...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g),
    ].map((m) => JSON.parse(m[1]!) as { "@graph": { "@type": string }[] });
    expect(blocks.length).toBeGreaterThan(0);
    const found = blocks.flatMap((b) => b["@graph"].map((n) => n["@type"]));
    for (const type of types) expect(found).toContain(type);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(violations).toEqual([]);
  });
}
