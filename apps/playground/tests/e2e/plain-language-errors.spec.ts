import { expect, test, type Page, type Route } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { errorCopy } from "../../lib/error-copy";
import { getMessPlanForMode } from "../../lib/mess-plan";
import { appAlerts } from "./alerts";

// Every failure here is injected at the playground's own route boundary, so nothing is funded or
// submitted. What is asserted is the copy the visitor reads: it must be the plain-language map in
// lib/error-copy.ts, and none of the raw text the failure carried may reach the screen. Mirrors
// apps/web/tests/e2e/plain-language-errors.spec.ts.

const BASE = "http://localhost:3002";

const RAW_LEAK =
  /\b(tx|op)_[a-z_]+\b|\b\w*(Error|Exception)\b|HostFunction|RPC_ERROR|\bat \S+ \(|\(\d{3}\)|Request failed|undefined|\[object|not_configured|session_not_found/;

// Raw upstream text a careless route could pass through; none of it may be rendered.
const UPSTREAM = "op_underfunded HostFunctionError at submit (horizon.js:12) RPC_ERROR (503)";

const isCreate = (url: URL): boolean => url.origin === BASE && url.pathname === "/api/session";
const isMessStep = (url: URL): boolean =>
  url.origin === BASE && url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/mess");

const isState = (url: URL): boolean =>
  url.origin === BASE &&
  url.pathname.startsWith("/api/session/") &&
  url.pathname.endsWith("/state");
const isDemolishRound = (url: URL): boolean =>
  url.origin === BASE &&
  url.pathname.startsWith("/api/session/") &&
  url.pathname.endsWith("/demolish/round");

function reply(status: number, body: Record<string, unknown>) {
  return (route: Route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** A create response for a session that exists only in this test. */
function fakeSession(): Record<string, unknown> {
  const demo = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  return {
    sessionId: "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01",
    demoPublic: demo,
    expiresAt: Date.now() + 3_600_000,
    messPlan: getMessPlanForMode("light"),
    accounts: {
      issuer,
      mm: Keypair.random().publicKey(),
      lwdemoAsset: `LWDEMO:${issuer}`,
      ephemeral: [],
    },
  };
}

async function startAndExpectAlert(page: Page, code: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  const alert = appAlerts(page);
  await expect(alert).toHaveText(errorCopy(code), { timeout: 30_000 });
  const text = await alert.innerText();
  expect(text).not.toMatch(RAW_LEAK);
  expect(text).not.toContain("op_underfunded");
}

test("an unavailable service shows the not-configured copy", async ({ page }) => {
  await page.route(isCreate, reply(503, { error: "not_configured", detail: UPSTREAM }));
  await startAndExpectAlert(page, "not_configured");
});

test("an expired session shows the expired-session copy", async ({ page }) => {
  await page.route(isCreate, reply(200, fakeSession()));
  await page.route(isMessStep, reply(404, { error: "session_not_found", message: UPSTREAM }));
  await startAndExpectAlert(page, "session_not_found");
});

test("a failed step shows the failed-transaction copy", async ({ page }) => {
  await page.route(isCreate, reply(200, fakeSession()));
  await page.route(isMessStep, reply(502, { error: "tx_failed", message: UPSTREAM }));
  await startAndExpectAlert(page, "tx_failed");
});

test("a close that stops part way offers a resume and warns before abandoning the account", async ({
  page,
}) => {
  await page.route(isCreate, reply(200, fakeSession()));
  await page.route(isMessStep, reply(200, { stepId: "SETUP", txHash: "c".repeat(64) }));
  await page.route(
    isState,
    reply(200, {
      demoPublic: Keypair.random().publicKey(),
      accountState: { nativeBalanceLumens: "9999.5", numSubEntries: 1 },
      completedMessSteps: [],
      demolishLog: [],
      demolishDone: false,
    })
  );
  await page.route(
    isDemolishRound,
    reply(502, { error: "demolish_outcome_unknown", message: UPSTREAM })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  await page.getByRole("button", { name: "Demolish it here" }).click({ timeout: 30_000 });

  const alert = appAlerts(page);
  await expect(alert).toHaveText(errorCopy("demolish_outcome_unknown"), { timeout: 30_000 });
  expect(await alert.innerText()).not.toMatch(RAW_LEAK);
  await expect(page.getByRole("button", { name: "Resume the close" })).toBeVisible();

  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await expect(page.getByText("Starting over abandons it there")).toBeVisible();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByText("Starting over abandons it there")).toHaveCount(0);
});
