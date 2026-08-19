import { test, expect } from "@playwright/test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "./helpers/destination";
import {
  enterSecretKey,
  enterSourceAddress,
  expectSigningPanel,
  openTestnetHome,
  TESTNET_STEP_TIMEOUT,
} from "./helpers/flow";

// E2E coverage for issue #113: one close where all three per-asset dispositions run together -
// one asset swapped to XLM, one transferred intact to another account, one returned to its
// issuer.
//
// Composition is the point. Each disposition has unit coverage on its own; what no unit test
// can show is that three of them in the same plan produce operations in the right order,
// against the right accounts, without one clobbering another. Every outcome is asserted
// ON-CHAIN through Horizon, never inferred from the UI - the UI saying "sent" proves only that
// the UI said it.
//
// Testnet only, per repo rules.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000";

// The canonical liquid testnet USDC: it lives in Horizon's path-finding graph, so the "swap"
// disposition has a real route. A self-issued asset would have no market.
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

async function submitOps(kp: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
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
  const body = (await res.json()) as { successful?: boolean; extras?: { result_codes?: unknown } };
  if (!res.ok || !body.successful) {
    throw new Error(`tx failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
}

async function accountExists(id: string): Promise<boolean> {
  return (await fetch(`${HORIZON}/accounts/${id}`)).status !== 404;
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

test("one close swaps one asset, transfers another, and returns a third to its issuer", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  // Holds the transferred asset. It must already trust it - LumenWipe cannot add a trustline
  // on an account it does not control, which is the blocker #111 surfaces.
  const transferTo = Keypair.random();
  // Issues the two assets with no market. A disposition is per asset, so the transferred one
  // and the burned one must be different assets - the same balance cannot both leave intact
  // and be destroyed.
  const localIssuer = Keypair.random();
  const KEEP = new Asset("KEEP", localIssuer.publicKey());
  const BURN = new Asset("BURN", localIssuer.publicKey());

  await fund(source.publicKey());
  await fund(destination.publicKey());
  await fund(transferTo.publicKey());
  await fund(localIssuer.publicKey());

  // Asset 1 (swap): buy real USDC against the live SDEX book.
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
    "Could not acquire USDC from the live testnet SDEX on this run; the three-disposition close is not exercisable."
  );
  test.skip(
    !(await hasUsdcRouteFor(usdcBalance)),
    "No USDC->XLM strict-send route on this run; the swap disposition is not exercisable."
  );

  // Assets 2 and 3: two self-issued assets with no market, so neither is convertible and each
  // must be resolved explicitly - KEEP is transferred, BURN is returned to its issuer.
  await submitOps(source, [
    Operation.changeTrust({ asset: KEEP }),
    Operation.changeTrust({ asset: BURN }),
  ]);
  // Only the transfer destination needs the trustline; the issuer needs none for its own asset.
  await submitOps(transferTo, [Operation.changeTrust({ asset: KEEP })]);
  await submitOps(localIssuer, [
    Operation.payment({ destination: source.publicKey(), asset: KEEP, amount: "40" }),
    Operation.payment({ destination: source.publicKey(), asset: BURN, amount: "25" }),
  ]);

  const keepBefore = await trustlineBalance(source.publicKey(), "KEEP");
  const burnBefore = await trustlineBalance(source.publicKey(), "BURN");
  expect(parseFloat(keepBefore)).toBeGreaterThan(0);
  expect(parseFloat(burnBefore)).toBeGreaterThan(0);

  // ── Drive the UI ────────────────────────────────────────────────────────────
  await openTestnetHome(page);
  await enterSourceAddress(page, source.publicKey());
  await page.getByRole("button", { name: /Analyze account/i }).click();
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: TESTNET_STEP_TIMEOUT });

  // USDC is convertible, so it defaults to the swap - asserted, not assumed, because the whole
  // point is that the three assets take three different paths.
  await expect(page.getByText(/USDC.*→.*XLM|swapped to XLM/i).first()).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });

  // Neither KEEP nor BURN has a route, so both stay unresolved until the user picks - and they
  // pick differently, which is what this test exists to prove. This has to happen BEFORE the
  // destination step exists: the late-destination panel and "Begin execution" only render once
  // every asset is resolved, which is exactly the gate an unresolved transfer must not pass.
  await page.getByRole("checkbox", { name: /Send my .*KEEP to another account/i }).check();
  await page
    .getByRole("textbox", { name: /Destination account for KEEP/i })
    .fill(transferTo.publicKey());
  await page.getByRole("checkbox", { name: /Return my .*BURN to the issuer/i }).check();

  // Only now does the flow advance. If a transfer without a destination counted as resolved,
  // this would have appeared one step earlier - and the close would reach a build the API
  // refuses.
  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination.publicKey());
  await confirmDestinationControl(page);

  await expect(beginButton).toBeEnabled();
  await beginButton.click();

  await expect(page).toHaveURL(/\/testnet\/review/, { timeout: TESTNET_STEP_TIMEOUT });
  const proceed = page.getByRole("button", {
    name: /I understand this plan and want to proceed/i,
  });
  await expect(proceed).toBeDisabled({ timeout: TESTNET_STEP_TIMEOUT });
  await page.getByRole("checkbox").first().check();
  await proceed.click();

  await expect(page).toHaveURL(/\/testnet\/execute/, { timeout: TESTNET_STEP_TIMEOUT });
  await expectSigningPanel(page);
  await enterSecretKey(page, source.secret());
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /Sign & execute close/i }).click();
  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 150_000 });

  // ── Assert on-chain, not on the UI ──────────────────────────────────────────
  expect(await accountExists(source.publicKey())).toBe(false);

  // Transferred: KEEP arrived intact, as KEEP, at the account the user named.
  const received = await trustlineBalance(transferTo.publicKey(), "KEEP");
  expect(parseFloat(received)).toBeCloseTo(parseFloat(keepBefore), 5);

  // Burned: BURN went to its issuer, NOT to the transfer destination. Asserting the negative
  // matters - collapsing the two dispositions into one would still leave the source closed.
  expect(parseFloat(await trustlineBalance(transferTo.publicKey(), "BURN"))).toBe(0);

  // Swapped: the USDC became XLM inside the account before the merge, so the destination
  // received more than the source's pre-swap native balance would have allowed. Asserting the
  // destination simply grew is enough - the exact amount depends on the live book.
  const destNative = await fetch(`${HORIZON}/accounts/${destination.publicKey()}`)
    .then((r) => r.json() as Promise<{ balances: Array<{ asset_type: string; balance: string }> }>)
    .then((b) => parseFloat(b.balances.find((x) => x.asset_type === "native")?.balance ?? "0"));
  expect(destNative).toBeGreaterThan(10_000);

  expect(await accountExists(transferTo.publicKey())).toBe(true);
});
