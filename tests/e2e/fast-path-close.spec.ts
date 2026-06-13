import { test, expect, type Page } from "@playwright/test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// E2E coverage for the fused single-transaction fast-path, exercised end-to-end
// against TESTNET through the real secret-key UI (not the custodial playground
// signing endpoint). Each test funds a throwaway testnet account, drives
// home -> analyze -> execute, signs once, and asserts on-chain that the source
// account no longer exists (it was merged away).
//
// Testnet only, per repo rules: the app's testnet RPC submission path is hit by
// the browser; this spec only ever talks to friendbot/Horizon-testnet directly
// for setup and final assertions.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000"; // generous per-op fee for setup txs; the app builds its own fee

// The canonical, liquid testnet USDC. Unlike a freshly self-issued asset, this
// already lives in Horizon's path-finding graph, so a strict-send USDC -> XLM
// route is reliably discoverable - which is exactly what the fused conversion
// path needs.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

// ── Testnet helpers (mirror scripts/setup-playground.ts) ─────────────────────────

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function loadSequence(id: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  return ((await res.json()) as { sequence: string }).sequence;
}

async function submitOps(kp: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
  const builder = new TransactionBuilder(
    new Account(kp.publicKey(), await loadSequence(kp.publicKey())),
    {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    }
  ).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXDR("base64") }),
  });
  const body = (await res.json()) as {
    successful?: boolean;
    extras?: { result_codes?: unknown };
  };
  if (!res.ok || !body.successful) {
    throw new Error(`tx failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status !== 404;
}

// Reads a held trustline balance straight from Horizon.
async function trustlineBalance(id: string, code: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  const body = (await res.json()) as {
    balances: Array<{ asset_code?: string; balance: string }>;
  };
  return body.balances.find((b) => b.asset_code === code)?.balance ?? "0";
}

// Polls Horizon strict-send path finding for a USDC -> XLM route covering the
// given amount. USDC is liquid on testnet, so this normally resolves at once.
async function hasRouteFor(amount: string, attempts = 8, delayMs = 2_500): Promise<boolean> {
  const url =
    `${HORIZON}/paths/strict-send?source_asset_type=credit_alphanum4` +
    `&source_asset_code=USDC&source_asset_issuer=${USDC_ISSUER}` +
    `&source_amount=${amount}&destination_assets=native`;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as { _embedded?: { records?: unknown[] } };
      if ((body._embedded?.records?.length ?? 0) > 0) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

// ── UI driver: home -> analyze -> execute -> sign once -> complete ───────────────

async function driveFusedClose(
  page: Page,
  opts: { source: Keypair; destination: string }
): Promise<void> {
  // Home: enter source + destination, analyze.
  await page.goto("/testnet");

  // A risk-disclaimer modal blocks the page on the first visit of a session and
  // intercepts pointer events until accepted. Dismiss it before driving the form.
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
  }

  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(opts.source.publicKey());
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(opts.destination);

  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  // Analyze: the fast-path collapses the whole close into one "Close account"
  // step. Wait for the plan to render, then assert it is a single fused step.
  await expect(page).toHaveURL(/\/testnet\/analyze/);
  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeEnabled({ timeout: 30_000 });

  await expect(page.getByText("Close account", { exact: true })).toBeVisible();
  await expect(page.getByText(/^1 step/)).toBeVisible();
  await beginButton.click();

  // Execute: a single fused close carries the merge, so the panel surfaces the
  // irreversible-merge warning and the "Sign and merge account" button.
  await expect(page).toHaveURL(/\/testnet\/execute/);
  await expect(page.getByRole("heading", { name: /Close account/i })).toBeVisible({
    timeout: 30_000,
  });

  // Secret key (entered once, held in memory for the session).
  await page.getByPlaceholder("S...").fill(opts.source.secret());

  // Per-step confirmation checkbox.
  await page.getByRole("checkbox").check();

  const signButton = page.getByRole("button", { name: /Sign and merge account/i });
  await expect(signButton).toBeEnabled();
  await signButton.click();

  // The wizard auto-advances to /complete once the only step confirms.
  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 90_000 });
}

// ── Test 1: data-entry-only account (no convertible balances) ────────────────────

test("fused close: data-entry-only account is merged in one signed transaction", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const source = Keypair.random();
  const destination = Keypair.random();

  await fund(source.publicKey());
  await fund(destination.publicKey());

  // One data entry holds the account open: cleanup + merge fuse into one tx.
  await submitOps(source, [Operation.manageData({ name: "lw-e2e-marker", value: "1" })]);

  expect(await accountExists(source.publicKey())).toBe(true);

  await driveFusedClose(page, { source, destination: destination.publicKey() });

  // On-chain truth: the source account is gone (merged into the destination).
  expect(await accountExists(source.publicKey())).toBe(false);
});

// ── Test 2: account holding one liquid asset (convert + merge, fused) ─────────────
//
// The source acquires a real, liquid testnet USDC balance by market-buying it
// against the live SDEX book. Any unfilled remainder rests as an open offer,
// which is harmlessly cancelled inside the fused close (offers are folded into
// the single CLOSE_ACCOUNT transaction). USDC has a discoverable strict-send
// USDC -> XLM route, so the analyze page produces a single fused "Close account"
// step that converts the balance and merges in one transaction.
//
// Acquiring USDC depends on live SDEX liquidity. If the buy does not fill or the
// reverse route is not discoverable, the analyze page would correctly degrade to
// the stepwise plan (no single fused step) - so we skip with a clear reason
// rather than assert a false negative. We never fake the conversion.

test("fused close: account with a liquid asset converts and merges in one transaction", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const source = Keypair.random();
  const destination = Keypair.random();

  await fund(source.publicKey());
  await fund(destination.publicKey());

  // Trustline + market buy of USDC, paying XLM. A high price crosses whatever
  // sell-USDC offers exist so the order fills against the live book.
  await submitOps(source, [Operation.changeTrust({ asset: USDC })]);
  await submitOps(source, [
    Operation.manageBuyOffer({
      selling: Asset.native(),
      buying: USDC,
      buyAmount: "5",
      price: "100",
    }),
  ]);

  const usdcBalance = await trustlineBalance(source.publicKey(), "USDC");
  test.skip(
    !(parseFloat(usdcBalance) > 0),
    "Could not acquire a USDC balance from the live testnet SDEX on this run; the convert+merge fast-path is not exercisable."
  );

  // The fused close needs a discoverable reverse route for the held balance.
  const hasRoute = await hasRouteFor(usdcBalance);
  test.skip(
    !hasRoute,
    "Testnet strict-send path finding returned no USDC->XLM route for the held balance; fused conversion path is not exercisable on this run."
  );

  expect(await accountExists(source.publicKey())).toBe(true);

  await driveFusedClose(page, { source, destination: destination.publicKey() });

  expect(await accountExists(source.publicKey())).toBe(false);
});
