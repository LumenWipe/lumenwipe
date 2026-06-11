/**
 * End-to-end test of the testnet playground: custodial session -> full mess
 * sequence -> state asserts -> negative sign tests -> real demolish via the
 * sign endpoint -> final asserts (account deleted, MM received the merge).
 *
 * Requires the app running with the PLAYGROUND_* envs set
 * (see scripts/setup-playground.ts):
 *
 *   APP_URL=http://localhost:3000 bun scripts/test-playground-flow.ts
 */
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { buildStepXdrForPlan, type StepBuildContext } from "@/lib/stellar/step-engine";
import { submitAndWait } from "@/lib/stellar/submit";
import { NoConversionPathError } from "@/lib/utils/errors";
import type { AccountState } from "@/types/account";
import type { MessStepDef } from "@/lib/playground/mess-plan";

const APP = process.env.APP_URL || "http://localhost:3000";
const HORIZON = "https://horizon-testnet.stellar.org";

const log = (s: string) => process.stdout.write(s + "\n");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${APP}/api/playground${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface SessionResponse {
  sessionId: string;
  demoPublic: string;
  messPlan: MessStepDef[];
  accounts: { issuer: string; mm: string; lwdemoAsset: string };
}

// ── Session + mess ─────────────────────────────────────────────────────────────
log("[1] Creating custodial session...");
const session = await api<SessionResponse>("/session", { method: "POST" });
log(`    demo: ${session.demoPublic}`);

log("[2] Running the full mess sequence...");
for (const step of session.messPlan) {
  const { txHash } = await api<{ txHash: string }>(`/session/${session.sessionId}/mess`, {
    method: "POST",
    body: JSON.stringify({ stepId: step.id }),
  });
  log(`    ${step.id}: ${txHash.slice(0, 10)}…`);
}

log("[3] Asserting the dirty state...");
const fetchState = async () =>
  (await api<{ accountState: AccountState | null }>(`/session/${session.sessionId}/state`))
    .accountState;
const dirty = (await fetchState())!;
check("3 trustlines", dirty.trustlines.length === 3, `got ${dirty.trustlines.length}`);
check(
  "all trustlines funded",
  dirty.trustlines.every((t) => parseFloat(t.balance) > 0),
  dirty.trustlines.map((t) => `${t.code}=${t.balance}`).join(", ")
);
check("3 open offers", dirty.openOffers.length === 3, `got ${dirty.openOffers.length}`);
check("3 data entries", dirty.dataEntries.length === 3, `got ${dirty.dataEntries.length}`);
check("extra signer present", dirty.signers.length === 2, `got ${dirty.signers.length}`);
check("subentries locked", dirty.numSubEntries === 10, `got ${dirty.numSubEntries}`);

// ── Negative sign tests ────────────────────────────────────────────────────────
log("[4] Negative sign-endpoint tests...");
const attacker = Keypair.random();

async function signStatus(xdr: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${APP}/api/playground/session/${session.sessionId}/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: xdr }),
  });
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: body.error };
}

const foreignSource = new TransactionBuilder(new Account(attacker.publicKey(), "1"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.accountMerge({ destination: session.accounts.mm }))
  .setTimeout(300)
  .build();
const r1 = await signStatus(foreignSource.toEnvelope().toXDR("base64"));
check(
  "foreign source rejected",
  r1.status === 400 && r1.error === "source_not_allowed",
  `${r1.status} ${r1.error}`
);

const exfiltrate = new TransactionBuilder(new Account(session.demoPublic, "1"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.payment({
      destination: attacker.publicKey(),
      asset: Asset.native(),
      amount: "5",
    })
  )
  .setTimeout(300)
  .build();
const r2 = await signStatus(exfiltrate.toEnvelope().toXDR("base64"));
check(
  "external destination rejected",
  r2.status === 400 && r2.error === "destination_not_allowed",
  `${r2.status} ${r2.error}`
);

// ── Demolish via the real engine + remote signing ─────────────────────────────
log("[5] Demolishing with the real engine (remote signing)...");
const mmBefore = await fetch(`${HORIZON}/accounts/${session.accounts.mm}`)
  .then((r) => r.json() as Promise<{ balances: Array<{ asset_type: string; balance: string }> }>)
  .then((a) => parseFloat(a.balances.find((b) => b.asset_type === "native")!.balance));

const plan = buildPlan(dirty, false);
log(`    plan: ${plan.map((s) => s.type).join(" → ")}`);

let usedDexConversion = false;
let usedIssuerFallback = false;

for (const step of plan) {
  const accountState = (await fetchState())!;
  const ctx: StepBuildContext = {
    network: "testnet",
    sourceAddress: session.demoPublic,
    accountState,
    destinationAddress: session.accounts.mm,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    executionPlan: plan,
  };

  let unsigned: string;
  try {
    unsigned = await buildStepXdrForPlan(step, ctx);
    if (step.type === "CONVERT_ASSETS") usedDexConversion = true;
  } catch (err) {
    if (err instanceof NoConversionPathError && step.type === "CONVERT_ASSETS") {
      usedIssuerFallback = true;
      unsigned = await buildStepXdrForPlan({ ...step, fallbackToIssuer: true }, ctx);
    } else {
      throw err;
    }
  }

  const { transaction: signed } = await api<{ transaction: string }>(
    `/session/${session.sessionId}/sign`,
    { method: "POST", body: JSON.stringify({ transaction: unsigned }) }
  );
  const { txHash } = await submitAndWait(signed, "testnet");
  log(
    `    ${step.type}${step.affectedAsset ? ` (${step.affectedAsset.split(":")[0]})` : ""}: ${txHash.slice(0, 10)}…`
  );
}

// ── Final asserts ──────────────────────────────────────────────────────────────
log("[6] Final asserts...");
const demoGone = await fetch(`${HORIZON}/accounts/${session.demoPublic}`).then(
  (r) => r.status === 404
);
check("demo account deleted from the ledger", demoGone);

const mmAfter = await fetch(`${HORIZON}/accounts/${session.accounts.mm}`)
  .then((r) => r.json() as Promise<{ balances: Array<{ asset_type: string; balance: string }> }>)
  .then((a) => parseFloat(a.balances.find((b) => b.asset_type === "native")!.balance));
check("MM received the merge", mmAfter > mmBefore, `Δ +${(mmAfter - mmBefore).toFixed(7)} XLM`);
check("DEX conversion path exercised", usedDexConversion);
check("send-to-issuer fallback exercised", usedIssuerFallback);

log(failures === 0 ? "\n✅ PLAYGROUND E2E PASS" : `\n❌ PLAYGROUND E2E FAIL (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
