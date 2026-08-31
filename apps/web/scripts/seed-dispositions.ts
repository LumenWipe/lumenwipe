/**
 * Seeds a testnet account that exercises all three per-asset dispositions in one close.
 *
 *   USDC  a real SDEX route exists  -> convert to XLM (the app's default)
 *   KEEP  no market                 -> transfer intact to an account that pre-trusts it
 *   BURN  no market                 -> return to its issuer
 *
 * The three have to be different assets: one balance cannot both leave intact and be destroyed.
 *
 *   bun run apps/web/scripts/seed-dispositions.ts
 *
 * A close is irreversible, so running one consumes the account. Re-run to seed another.
 *
 * Mirrors the setup in apps/web/tests/e2e/three-dispositions.spec.ts.
 */

import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000";

// The canonical liquid testnet USDC: it lives in Horizon's path-finding graph, so the swap
// disposition has a real route. A freshly self-issued asset would have no market at all.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

const KEEP_AMOUNT = "40";
const BURN_AMOUNT = "25";

function log(step: string, detail = ""): void {
  console.log(`  ${step.padEnd(38)} ${detail}`);
}

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
  const body = (await res.json()) as { successful?: boolean; extras?: { result_codes?: unknown } };
  if (!res.ok || !body.successful) {
    throw new Error(`tx failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
}

async function trustlineBalance(id: string, code: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  const body = (await res.json()) as { balances: Array<{ asset_code?: string; balance: string }> };
  return body.balances.find((b) => b.asset_code === code)?.balance ?? "0";
}

/** The swap disposition needs Horizon to actually route USDC back to XLM. Checked up front
 *  rather than discovered mid-close. */
async function hasUsdcRoute(amount: string, attempts = 8, delayMs = 2_500): Promise<boolean> {
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
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main(): Promise<void> {
  const source = Keypair.random();
  const destination = Keypair.random();
  const transferTo = Keypair.random();
  const localIssuer = Keypair.random();

  const KEEP = new Asset("KEEP", localIssuer.publicKey());
  const BURN = new Asset("BURN", localIssuer.publicKey());

  console.log("\nSeeding a three-disposition account on TESTNET\n");

  log("Funding four accounts…");
  await Promise.all(
    [source, destination, transferTo, localIssuer].map((kp) => fund(kp.publicKey()))
  );
  log("  funded", "source · destination · transferTo · issuer");

  log("Buying USDC on the live SDEX…");
  await submitOps(source, [Operation.changeTrust({ asset: USDC })]);
  await submitOps(source, [
    Operation.manageBuyOffer({
      selling: Asset.native(),
      buying: USDC,
      buyAmount: "5",
      price: "100",
    }),
  ]);
  const usdc = await trustlineBalance(source.publicKey(), "USDC");
  if (!(parseFloat(usdc) > 0)) {
    throw new Error(
      "Could not acquire USDC from the testnet SDEX right now. The convert disposition is " +
        "not exercisable on this run - retry in a few minutes."
    );
  }
  log("  acquired", `${usdc} USDC`);

  log("Checking the USDC -> XLM route…");
  if (!(await hasUsdcRoute(usdc))) {
    throw new Error(
      "No USDC->XLM strict-send route right now, so the app will not offer the swap " +
        "disposition - retry shortly."
    );
  }
  log("  route", "live");

  log("Issuing KEEP and BURN…");
  await submitOps(source, [
    Operation.changeTrust({ asset: KEEP }),
    Operation.changeTrust({ asset: BURN }),
  ]);
  // Only the transfer destination needs the trustline. LumenWipe cannot add a trustline on an
  // account it does not control - that is exactly the blocker the transfer path surfaces.
  await submitOps(transferTo, [Operation.changeTrust({ asset: KEEP })]);
  await submitOps(localIssuer, [
    Operation.payment({ destination: source.publicKey(), asset: KEEP, amount: KEEP_AMOUNT }),
    Operation.payment({ destination: source.publicKey(), asset: BURN, amount: BURN_AMOUNT }),
  ]);
  log("  balances", `${KEEP_AMOUNT} KEEP · ${BURN_AMOUNT} BURN`);

  const bar = "─".repeat(78);
  console.log(`\n${bar}\n  SEEDED\n${bar}\n`);
  console.log("  Paste into the app (lumenwipe.com/testnet or localhost:3000/testnet)\n");
  console.log(`    Source account   ${source.publicKey()}`);
  console.log(`    Source SECRET    ${source.secret()}`);
  console.log(`    XLM destination  ${destination.publicKey()}`);
  console.log(`    KEEP goes to     ${transferTo.publicKey()}`);
  console.log(`\n  Assets on the source account\n`);
  console.log(`    USDC   ${usdc.padEnd(14)} convert   (app defaults to this - a route exists)`);
  console.log(
    `    KEEP   ${KEEP_AMOUNT.padEnd(14)} transfer  (to ${transferTo.publicKey().slice(0, 8)}…)`
  );
  console.log(`    BURN   ${BURN_AMOUNT.padEnd(14)} burn      (back to the issuer)`);
  console.log(`\n  Verify afterwards on stellar.expert (testnet)\n`);
  console.log(
    `    source gone      https://stellar.expert/explorer/testnet/account/${source.publicKey()}`
  );
  console.log(
    `    XLM arrived      https://stellar.expert/explorer/testnet/account/${destination.publicKey()}`
  );
  console.log(
    `    KEEP arrived     https://stellar.expert/explorer/testnet/account/${transferTo.publicKey()}`
  );
  console.log(
    `    issuer got BURN  https://stellar.expert/explorer/testnet/account/${localIssuer.publicKey()}`
  );
  console.log(`\n${bar}\n`);
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
