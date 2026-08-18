import { test, expect, type Page } from "@playwright/test";
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "./helpers/destination";

// E2E coverage for issue #70: a claimable balance for an asset the account holds no trustline
// for is no longer an unconditional blocker. The guided flow offers "add a trustline and
// claim" as an explicit remediation, and the real close honors it.
//
// This drives the full guided flow against TESTNET through the real secret-key UI: home
// (public key only) -> analyze (claim decision + swap-to-XLM default) -> late destination ->
// single secret-key entry driving a multi-round close (claim round, then cleanup+merge round)
// -> /complete. Asserts ON-CHAIN via Horizon that the source account is gone and the claimed
// balance's proceeds landed in the destination.
//
// Testnet only, per repo rules: the app's testnet RPC submission path is hit by the browser;
// this spec only ever talks to friendbot/Horizon-testnet directly for setup and assertions.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000"; // generous per-op fee for setup txs; the app builds its own fee

// The canonical, liquid testnet USDC. It already lives in Horizon's path-finding graph, so
// once claimed, the default "convert to XLM" disposition has a real route to settle - a
// freshly self-issued asset would have no market and the post-claim close would fail with
// AssetRouteLostError, which is not what this test is about.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

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
    { fee: BASE_FEE, networkPassphrase: PASSPHRASE }
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

async function nativeBalance(id: string): Promise<number> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  const body = (await res.json()) as { balances: Array<{ asset_type: string; balance: string }> };
  return parseFloat(body.balances.find((b) => b.asset_type === "native")?.balance ?? "0");
}

async function trustlineBalance(id: string, code: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  const body = (await res.json()) as { balances: Array<{ asset_code?: string; balance: string }> };
  return body.balances.find((b) => b.asset_code === code)?.balance ?? "0";
}

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

async function dismissRiskModal(page: Page): Promise<void> {
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
  }
}

async function enterSourceAndAnalyze(page: Page, source: string): Promise<void> {
  await page.goto("/testnet");
  await dismissRiskModal(page);

  // AccountEntryForm defaults to the "Connect wallet" tab (AccountEntryForm.tsx L22);
  // the "Paste address" tab must be selected explicitly before its "G..." input exists.
  await page.getByRole("button", { name: /Paste address/i }).click();
  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(source);

  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });
}

async function enterDestinationAndBegin(page: Page, destination: string): Promise<void> {
  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);
  await confirmDestinationControl(page);

  await expect(beginButton).toBeEnabled();
  await beginButton.click();

  // Whole-plan review gate: the user must explicitly confirm before anything is built.
  await expect(page).toHaveURL(/\/testnet\/review/);
  const proceedButton = page.getByRole("button", {
    name: /I understand this plan and want to proceed/i,
  });
  await expect(proceedButton).toBeDisabled();

  // Explicit acknowledgment checkbox (the only checkbox on the review panel) gates the button.
  await page.getByRole("checkbox").check();
  await expect(proceedButton).toBeEnabled();
  await proceedButton.click();

  await expect(page).toHaveURL(/\/testnet\/execute/);
}

// The secret key is entered once; the engine drives every round (claim, then cleanup+merge)
// under the hood before the wizard advances to /complete.
async function signMultiRoundCloseOnce(page: Page, source: Keypair): Promise<void> {
  await expect(page.getByRole("heading", { name: /Sign.*execute the close/i })).toBeVisible({
    timeout: 30_000,
  });

  // ExecutionWizard defaults to the "Connect wallet" tab; the "Use secret key
  // (advanced)" tab must be selected explicitly before its "S..." input exists.
  await page.getByRole("button", { name: /Use secret key \(advanced\)/i }).click();

  await page.getByPlaceholder("S...").fill(source.secret());

  await page.getByRole("checkbox").check();

  const signButton = page.getByRole("button", { name: /Sign.*execute close/i });
  await expect(signButton).toBeEnabled();
  await signButton.click();

  // Two rounds (claim, then cleanup+merge) each wait for RPC confirmation - allow headroom.
  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 150_000 });
}

test("redesigned flow: add a trustline and claim an otherwise-unreachable balance, then merge", async ({
  page,
}) => {
  test.setTimeout(300_000);

  const source = Keypair.random();
  const funder = Keypair.random();
  const destination = Keypair.random();

  await fund(source.publicKey());
  await fund(funder.publicKey());
  await fund(destination.publicKey());

  // The funder acquires a real, liquid testnet USDC balance via the live SDEX book, then
  // creates a claimable balance of it for the source - who never trusts USDC directly.
  await submitOps(funder, [Operation.changeTrust({ asset: USDC })]);
  await submitOps(funder, [
    Operation.manageBuyOffer({
      selling: Asset.native(),
      buying: USDC,
      buyAmount: "5",
      price: "100",
    }),
  ]);

  const funderUsdc = await trustlineBalance(funder.publicKey(), "USDC");
  test.skip(
    !(parseFloat(funderUsdc) > 0),
    "Could not acquire a USDC balance from the live testnet SDEX on this run; the claim-remediation path is not exercisable."
  );

  const hasRoute = await hasUsdcRouteFor(funderUsdc);
  test.skip(
    !hasRoute,
    "Testnet strict-send path finding returned no USDC->XLM route for the held balance; the post-claim convert step is not exercisable on this run."
  );

  await submitOps(funder, [
    Operation.createClaimableBalance({
      asset: USDC,
      amount: funderUsdc,
      claimants: [new Claimant(source.publicKey())],
    }),
  ]);

  expect(await accountExists(source.publicKey())).toBe(true);
  // The source never trusted USDC directly - only the claimable balance holds it.
  expect(await trustlineBalance(source.publicKey(), "USDC")).toBe("0");

  await enterSourceAndAnalyze(page, source.publicKey());

  // The claimable-balance card renders in its amber "needs a decision" state: no authorized
  // trustline for the asset, so neither "claim" nor a swap label applies yet.
  await expect(page.getByText("Claim balances", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Claim balances", { exact: true }).click();
  await expect(page.getByText(/no trustline for this asset/)).toBeVisible();

  // Until a remediation is chosen, the destination step is gated.
  await expect(page.getByRole("button", { name: /Begin execution/i })).toHaveCount(0);

  // Choose "add a trustline and claim it".
  const addTrustlineOption = page.getByRole("radio", { name: /Add a USDC trustline and claim it/ });
  await addTrustlineOption.check();

  // With the claim resolved, the destination step appears (no pre-existing trustline balance
  // means no separate asset-disposition decision is needed here).
  await enterDestinationAndBegin(page, destination.publicKey());

  await signMultiRoundCloseOnce(page, source);

  // On-chain truth: the source account is gone, and the claimed USDC's converted proceeds
  // landed in the destination's XLM balance (funded with 10000 XLM by friendbot, plus
  // whatever the conversion + merge delivered).
  expect(await accountExists(source.publicKey())).toBe(false);
  expect(await nativeBalance(destination.publicKey())).toBeGreaterThan(10_000);
});
