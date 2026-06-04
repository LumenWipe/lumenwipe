/**
 * End-to-end test of the shared-mediator exchange-merge flow on TESTNET.
 *
 * It funds a fresh source and destination, builds the atomic
 * [accountMerge -> mediator, payment -> destination] transaction, signs the
 * user half, asks the running app's /mediator/sign endpoint to co-sign, submits,
 * and verifies the source is closed and the destination received ~100%.
 * It also checks that the endpoint REFUSES to co-sign a standalone mediator
 * payment (a theft attempt).
 *
 * Requires the app running with MEDIATOR_SECRET_TESTNET +
 * NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET set (see scripts/setup-mediator.ts).
 *
 *   APP_URL=http://localhost:3000 bun scripts/test-mediator-flow.ts
 */
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  Account,
  Networks,
} from "@stellar/stellar-sdk";

const APP = process.env.APP_URL || "http://localhost:3000";
const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const mediatorPub = process.env.NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET;
if (!mediatorPub) {
  process.stderr.write("Set NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET (run setup-mediator first).\n");
  process.exit(1);
}

type HzAccount = { sequence: string; balances: Array<{ asset_type: string; balance: string }> };

async function fund(pub: string): Promise<void> {
  const r = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}
async function load(id: string): Promise<HzAccount | null> {
  const r = await fetch(`${HORIZON}/accounts/${id}`);
  return r.ok ? ((await r.json()) as HzAccount) : null;
}
function native(a: HzAccount): string {
  return a.balances.find((b) => b.asset_type === "native")!.balance;
}
async function cosign(xdr: string): Promise<Response> {
  return fetch(`${APP}/api/testnet/mediator/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: xdr }),
  });
}
async function submit(xdr: string) {
  const r = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: xdr }),
  });
  return { ok: r.ok, body: await r.json() };
}

const log = (s: string) => process.stdout.write(s + "\n");

const source = Keypair.random();
const dest = Keypair.random();

log(`App:      ${APP}`);
log(`Mediator: ${mediatorPub}`);
log(`Source:   ${source.publicKey()}`);
log(`Dest:     ${dest.publicKey()}\n`);

log("Funding source + destination via friendbot...");
await fund(source.publicKey());
await fund(dest.publicKey());

const srcAcc = (await load(source.publicKey()))!;
const srcBalance = native(srcAcc);
const destBefore = native((await load(dest.publicKey()))!);
const medBefore = native((await load(mediatorPub))!);

// ── Security check: a standalone mediator payment must be REFUSED ──────────────
log("\n[security] Asking the endpoint to co-sign a standalone mediator payment (theft attempt)...");
const attacker = Keypair.random();
const evil = new TransactionBuilder(new Account(dest.publicKey(), (await load(dest.publicKey()))!.sequence), {
  fee: "100",
  networkPassphrase: PASSPHRASE,
})
  .addOperation(
    Operation.payment({
      source: mediatorPub,
      destination: attacker.publicKey(),
      asset: Asset.native(),
      amount: "1000",
    })
  )
  .setTimeout(120)
  .build();
evil.sign(dest);
const evilRes = await cosign(evil.toEnvelope().toXDR("base64"));
log(evilRes.ok ? "  ✗ ACCEPTED — SECURITY FAILURE" : `  ✓ rejected (HTTP ${evilRes.status})`);

// ── Happy path: atomic merge -> mediator -> destination ───────────────────────
const feeBuffer = (2 * 100) / 10_000_000;
const amount = (parseFloat(srcBalance) - feeBuffer).toFixed(7);
const tx = new TransactionBuilder(new Account(source.publicKey(), srcAcc.sequence), {
  fee: "100",
  networkPassphrase: PASSPHRASE,
})
  .addMemo(Memo.text("lw-e2e"))
  .addOperation(Operation.accountMerge({ destination: mediatorPub }))
  .addOperation(
    Operation.payment({
      source: mediatorPub,
      destination: dest.publicKey(),
      asset: Asset.native(),
      amount,
    })
  )
  .setTimeout(120)
  .build();
tx.sign(source);

log("\n[flow] Co-signing the forward payment via the app endpoint...");
const signRes = await cosign(tx.toEnvelope().toXDR("base64"));
if (!signRes.ok) {
  log(`  ✗ co-sign failed (HTTP ${signRes.status}): ${await signRes.text()}`);
  process.exit(1);
}
const { transaction: cosigned } = (await signRes.json()) as { transaction: string };
log("  ✓ co-signed");

log("[flow] Submitting the atomic transaction...");
const res = await submit(cosigned);
if (!res.ok || !res.body.successful) {
  log(`  ✗ submit failed: ${JSON.stringify(res.body.extras?.result_codes ?? res.body)}`);
  process.exit(1);
}
log(`  ✓ submitted: ${res.body.hash}`);

// ── Verify ────────────────────────────────────────────────────────────────────
const srcAfter = await load(source.publicKey());
const destAfter = native((await load(dest.publicKey()))!);
const medAfter = native((await load(mediatorPub))!);
const recovered = parseFloat(destAfter) - parseFloat(destBefore);

log("\nResults:");
log(`  source:   ${srcAfter ? "STILL EXISTS ✗" : "deleted ✓"}`);
log(`  source balance was: ${srcBalance} XLM`);
log(`  dest:     ${destBefore} → ${destAfter}  (+${recovered.toFixed(7)})`);
log(`  mediator: ${medBefore} → ${medAfter}  (Δ ${(parseFloat(medAfter) - parseFloat(medBefore)).toFixed(7)})`);

const pass =
  !srcAfter && !evilRes.ok && recovered > parseFloat(srcBalance) - 0.001;
log(
  pass
    ? "\n✅ E2E PASS — theft attempt rejected, source closed, user recovered ~100%."
    : "\n❌ E2E FAIL — see results above."
);
process.exit(pass ? 0 : 1);
