import { test, expect, type Page } from "@playwright/test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

// E2E coverage for the REDESIGNED single-transaction flow, exercised end-to-end
// against TESTNET through the real secret-key UI.
//
// The redesigned flow differs from the original fast-path:
//   - Home collects ONLY the source public key (no destination).
//   - /analyze shows an accordion plan preview plus a per-asset decision
//     (swap on the DEX vs. return to issuer).
//   - Once every asset is resolved, a destination + memo step appears.
//   - "Begin execution" -> /execute, where the secret key is entered ONCE and
//     the fused single close transaction is signed.
//   - /complete is the terminal page.
//
// Each test funds a throwaway testnet account, drives the full redesigned path,
// signs once, and asserts ON-CHAIN (via Horizon) that the source account no
// longer exists - it was merged away in a single transaction.
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
// path (the "swap" disposition) needs.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

// ── Testnet helpers (mirror fast-path-close.spec.ts) ─────────────────────────────

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function loadSequence(id: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  return ((await res.json()) as { sequence: string }).sequence;
}

async function submitOps(kp: Keypair, ops: xdr.Operation[]): Promise<void> {
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
async function hasUsdcRouteFor(amount: string, attempts = 8, delayMs = 2_500): Promise<boolean> {
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

// ── Shared UI fragments ──────────────────────────────────────────────────────────

// The risk-disclaimer modal blocks the page on the first visit of a session and
// intercepts pointer events until accepted. Dismiss it before driving the form.
async function dismissRiskModal(page: Page): Promise<void> {
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
  }
}

// Home -> analyze with ONLY the public key (the redesigned home no longer takes a
// destination). Lands on the analyze page once the plan preview has rendered.
async function enterSourceAndAnalyze(page: Page, source: string): Promise<void> {
  await page.goto("/testnet");
  await dismissRiskModal(page);

  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(source);

  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  await expect(page).toHaveURL(/\/testnet\/analyze/);
}

// Late-destination step: fills the destination, then "Begin execution" -> /execute.
async function enterDestinationAndBegin(page: Page, destination: string): Promise<void> {
  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);

  await expect(beginButton).toBeEnabled();
  await beginButton.click();

  await expect(page).toHaveURL(/\/testnet\/execute/);
}

// Execute: a single fused close carries the merge, so the panel surfaces the
// irreversible-merge warning and the "Sign and merge account" button. The secret
// key is entered ONCE for the whole session.
async function signSingleCloseOnce(page: Page, source: Keypair): Promise<void> {
  await expect(page.getByRole("heading", { name: /Close account/i })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByPlaceholder("S...").fill(source.secret());

  // Per-step confirmation checkbox (the only checkbox on the execute panel).
  await page.getByRole("checkbox").check();

  const signButton = page.getByRole("button", { name: /Sign and merge account/i });
  await expect(signButton).toBeEnabled();
  await signButton.click();

  // The wizard auto-advances to /complete once the only step confirms.
  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 90_000 });
}

// ── Test 1: happy path - one liquid asset, swapped + merged in one transaction ────
//
// The source acquires a real, liquid testnet USDC balance by market-buying it
// against the live SDEX book. USDC has a discoverable strict-send USDC -> XLM
// route, so the analyze page marks it convertible and auto-selects "swap". The
// redesigned flow then: home (public key only) -> analyze (accordion + swap
// label) -> late destination -> single signed close.
//
// Acquiring USDC depends on live SDEX liquidity. If the buy does not fill or the
// reverse route is not discoverable, we skip with a clear reason rather than
// assert a false negative. We never fake the conversion.

test("redesigned flow: convertible asset shows a swap label and merges in one tx", async ({
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
    "Could not acquire a USDC balance from the live testnet SDEX on this run; the swap+merge path is not exercisable."
  );

  const hasRoute = await hasUsdcRouteFor(usdcBalance);
  test.skip(
    !hasRoute,
    "Testnet strict-send path finding returned no USDC->XLM route for the held balance; the swap+merge path is not exercisable on this run."
  );

  expect(await accountExists(source.publicKey())).toBe(true);

  // Home -> analyze with ONLY the public key.
  await enterSourceAndAnalyze(page, source.publicKey());

  // The accordion preview renders. The "Handle assets" group is open by default
  // and the convertible asset shows the positive "Swap" label (NOT a convert/
  // return-to-issuer prompt).
  await expect(page.getByText("Handle assets", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/USDC.*will be swapped to XLM on the DEX/)).toBeVisible();
  await expect(page.getByText("Swap", { exact: true })).toBeVisible();
  // A convertible asset must not surface the no-route / return-to-issuer copy.
  await expect(page.getByText(/no swap route on the DEX/)).toHaveCount(0);

  // Convertible assets auto-resolve, so the destination step appears with no
  // per-asset action required.
  await enterDestinationAndBegin(page, destination.publicKey());

  await signSingleCloseOnce(page, source);

  // On-chain truth: the source account is gone (merged into the destination).
  expect(await accountExists(source.publicKey())).toBe(false);
});

// ── Test 2: mixed / return-to-issuer - non-convertible asset returned to issuer ───
//
// Intent: a separate, real testnet issuer account issues a custom asset (no DEX
// market) to the source. The analyze page should mark it non-convertible - the
// asset card shows "no swap route on the DEX" and requires confirming "return to
// issuer" - and then the fused close should return the balance to the issuer,
// remove the trustline, and merge in one signed transaction.
//
// The analyze gate behaves correctly (the no-route card renders and the per-asset
// "return to issuer" checkbox unlocks the destination step), and the fused close
// returns the balance to the issuer, removes the trustline, and merges in one
// signed transaction. This test previously failed because the analyze-page
// refresh re-ran setAccountState, which wiped the user's "return to issuer"
// decision; the fused close then defaulted to "convert", re-quoted the no-market
// asset at build time, and raised AssetRouteLostError. Fixed in 6b6f568:
// setAccountState now prunes dispositions to assets still present instead of
// clearing them, so the issuer decision survives the re-scan.

test("redesigned flow: non-convertible asset is returned to issuer, then merged in one tx", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const source = Keypair.random();
  const issuer = Keypair.random();
  const destination = Keypair.random();

  await fund(source.publicKey());
  await fund(issuer.publicKey());
  await fund(destination.publicKey());

  // A self-defined asset with no DEX market: source trusts it, issuer pays it in.
  const NOSWAP = new Asset("NOSWAP", issuer.publicKey());
  await submitOps(source, [Operation.changeTrust({ asset: NOSWAP })]);
  await submitOps(issuer, [
    Operation.payment({ destination: source.publicKey(), asset: NOSWAP, amount: "10" }),
  ]);

  const heldBalance = await trustlineBalance(source.publicKey(), "NOSWAP");
  expect(parseFloat(heldBalance)).toBeGreaterThan(0);

  expect(await accountExists(source.publicKey())).toBe(true);

  // Home -> analyze with ONLY the public key.
  await enterSourceAndAnalyze(page, source.publicKey());

  // The asset card surfaces the no-route state and the return-to-issuer control.
  // (The "Handle assets" accordion group is open by default.)
  await expect(page.getByText("Handle assets", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no swap route on the DEX/)).toBeVisible();

  // Until the user confirms returning the balance, the destination step is gated.
  await expect(page.getByRole("button", { name: /Begin execution/i })).toHaveCount(0);

  // Confirm "return to issuer" via the per-asset card checkbox.
  const returnCheckbox = page.getByRole("checkbox", { name: /Return my .*NOSWAP to the issuer/ });
  await returnCheckbox.check();

  // With every asset resolved, the late destination step appears.
  await enterDestinationAndBegin(page, destination.publicKey());

  await signSingleCloseOnce(page, source);

  // On-chain truth: the source account is gone (merged into the destination).
  expect(await accountExists(source.publicKey())).toBe(false);
});
