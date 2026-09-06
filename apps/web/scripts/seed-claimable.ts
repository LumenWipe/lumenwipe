/**
 * Seeds testnet accounts that exercise every claimable-balance outcome in one close.
 *
 * The three coexist on one account, because that is the interesting case:
 *
 *   EURC  the account already trusts it             -> claim (the opt-out default)
 *   USDC  no trustline, but the balance is worth it -> add a trustline and claim
 *   JUNK  worthless, not worth a reserve            -> forfeit, explicitly
 *
 * Only the first two produce work. The third is given up on the record, never silently.
 *
 * The second account is the opposite case: it SPONSORS a balance claimable by someone else.
 * CAP-33 gives it no way to revoke that on its own, so its close is blocked with an explanation
 * rather than failing halfway through.
 *
 *   bun run apps/web/scripts/seed-claimable.ts
 *
 * A close is irreversible, so running one consumes the first account. Re-run to seed another;
 * the sponsoring account survives, since it is only ever analysed.
 */

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

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000";

// The canonical liquid testnet USDC: it lives in Horizon's path-finding graph, so once claimed
// the balance has a real route to XLM and the app can offer the conversion.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

const EURC_AMOUNT = "4";
const JUNK_AMOUNT = "9";
const SPONSORED_CB_AMOUNT = "5";

function log(step: string, detail = ""): void {
  console.log(`  ${step.padEnd(40)} ${detail}`);
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

/** Checked up front rather than discovered mid-close: with no route the claimed USDC has
 *  nowhere to convert to, and the flow stalls on a decision this fixture is not about. */
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
  // Account A
  const source = Keypair.random();
  const funder = Keypair.random();
  const localIssuer = Keypair.random();
  const destination = Keypair.random();
  // Account B
  const sponsor = Keypair.random();
  const otherParty = Keypair.random();
  const sponsorDestination = Keypair.random();

  const EURC = new Asset("EURC", localIssuer.publicKey());
  const JUNK = new Asset("JUNK", localIssuer.publicKey());

  console.log("\nSeeding claimable-balance fixtures on TESTNET\n");

  log("Funding seven accounts…");
  await Promise.all(
    [source, funder, localIssuer, destination, sponsor, otherParty, sponsorDestination].map((kp) =>
      fund(kp.publicKey())
    )
  );
  log("  funded");

  // ── Account A, balance 1: an asset the account already trusts ────────────────
  log("A · EURC, already trusted…");
  await submitOps(source, [Operation.changeTrust({ asset: EURC })]);
  await submitOps(localIssuer, [
    Operation.createClaimableBalance({
      asset: EURC,
      amount: EURC_AMOUNT,
      claimants: [new Claimant(source.publicKey())],
    }),
  ]);
  log("  created", `${EURC_AMOUNT} EURC, trustline open`);

  // ── Account A, balance 2: an asset with no trustline, worth recovering ───────
  log("A · USDC, no trustline…");
  await submitOps(funder, [Operation.changeTrust({ asset: USDC })]);
  await submitOps(funder, [
    Operation.manageBuyOffer({
      selling: Asset.native(),
      buying: USDC,
      buyAmount: "5",
      price: "100",
    }),
  ]);
  const usdc = await trustlineBalance(funder.publicKey(), "USDC");
  if (!(parseFloat(usdc) > 0)) {
    throw new Error("Could not acquire USDC from the testnet SDEX right now - retry shortly.");
  }
  if (!(await hasUsdcRoute(usdc))) {
    throw new Error("No USDC->XLM route right now - retry shortly.");
  }
  await submitOps(funder, [
    Operation.createClaimableBalance({
      asset: USDC,
      amount: usdc,
      claimants: [new Claimant(source.publicKey())],
    }),
  ]);
  log("  created", `${usdc} USDC, no trustline, route live`);

  // ── Account A, balance 3: worthless, to be given up ──────────────────────────
  log("A · JUNK, to forfeit…");
  await submitOps(localIssuer, [
    Operation.createClaimableBalance({
      asset: JUNK,
      amount: JUNK_AMOUNT,
      claimants: [new Claimant(source.publicKey())],
    }),
  ]);
  log("  created", `${JUNK_AMOUNT} JUNK, no trustline, no market`);

  // ── Account B: sponsors a balance for someone else ─────────────────────────
  log("B · a balance it sponsors for another account…");
  await submitOps(sponsor, [
    Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: SPONSORED_CB_AMOUNT,
      claimants: [new Claimant(otherParty.publicKey())],
    }),
  ]);
  log("  created", `${SPONSORED_CB_AMOUNT} XLM, claimable by someone else`);

  const bar = "─".repeat(78);
  console.log(`\n${bar}\n  SEEDED\n${bar}\n`);

  console.log("  ACCOUNT A - three balances, three outcomes, one close\n");
  console.log(`    Source account   ${source.publicKey()}`);
  console.log(`    Source SECRET    ${source.secret()}`);
  console.log(`    XLM destination  ${destination.publicKey()}`);
  console.log(`\n    EURC  ${EURC_AMOUNT.padEnd(12)} already trusted   -> claim (default)`);
  console.log(`    USDC  ${usdc.padEnd(12)} no trustline      -> add a trustline and claim`);
  console.log(`    JUNK  ${JUNK_AMOUNT.padEnd(12)} no trustline      -> forfeit, explicitly`);
  console.log(
    `\n    Answering USDC surfaces a second decision: what to do with the claimed balance.`
  );

  console.log("\n  ACCOUNT B - sponsors a balance for someone else, and is blocked\n");
  console.log(`    Source account   ${sponsor.publicKey()}`);
  console.log(`    XLM destination  ${sponsorDestination.publicKey()}`);
  console.log(`    Only analysed, never closed. No secret key needed.`);

  console.log(`\n  Verify account A afterwards on stellar.expert (testnet)\n`);
  console.log(
    `    source gone      https://stellar.expert/explorer/testnet/account/${source.publicKey()}`
  );
  console.log(
    `    XLM arrived      https://stellar.expert/explorer/testnet/account/${destination.publicKey()}`
  );
  console.log(`\n${bar}\n`);
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
