import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ── /testnet regression ──
log("Checking /testnet...");
await page.goto("http://localhost:3000/testnet", { waitUntil: "domcontentloaded" });
const testnetH = await page
  .locator("h1,h2")
  .first()
  .innerText()
  .catch(() => "?");
log(`/testnet heading: "${testnetH}" → ${testnetH.length > 2 ? "PASS ✓" : "FAIL ✗"}`);

// ── /playground ──
log("Loading /playground...");
await page.goto("http://localhost:3000/playground", { waitUntil: "domcontentloaded" });
const h1 = await page
  .locator("h1")
  .first()
  .innerText()
  .catch(() => "?");
log(`Playground h1: "${h1}"`);
await page.screenshot({ path: "/tmp/pg-idle.png" });

log("Clicking start button...");
await page.locator("button", { hasText: /Create.*trash/i }).click();
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/pg-messing.png" });

log("Waiting for DIRTY state (3 min max)...");
await page.locator("button", { hasText: /Demolish it/i }).waitFor({ timeout: 180_000 });
log("DIRTY state reached ✓");
await page.screenshot({ path: "/tmp/pg-dirty.png" });
const linksD = await page.locator("a[href*='stellar.expert']").count();
log(`Explorer links after mess: ${linksD}`);

log("Clicking 'Demolish it'...");
await page.locator("button", { hasText: /Demolish it/i }).click();
log("Waiting for COMPLETE state (5 min max)...");
await page.locator("text=/Demolition complete|Run it again/i").waitFor({ timeout: 300_000 });
log("COMPLETE state reached ✓");
await page.screenshot({ path: "/tmp/pg-complete.png" });

const runAgain = await page.locator("button", { hasText: /Run it again/i }).isVisible();
const linksC = await page.locator("a[href*='stellar.expert']").count();
log(`'Run it again' visible: ${runAgain ? "✓" : "✗"}, explorer links: ${linksC}`);

await browser.close();
log("Done");
