/**
 * Sets up the persistent playground accounts on Stellar TESTNET:
 *  - LWDEMO issuer
 *  - Market maker: holds LWDEMO, posts a sell-XLM/buy-LWDEMO offer (the
 *    counterparty for the playground's LWDEMO -> XLM conversion) and acts as
 *    the merge destination for demo accounts.
 * Also generates the AES-256-GCM key for encrypting custodial session secrets.
 *
 *   bun scripts/setup-playground.ts
 */
import { randomBytes } from "node:crypto";
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Account,
  Networks,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

const log = (s: string) => process.stdout.write(s + "\n");

async function fund(pub: string): Promise<void> {
  const r = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${await r.text()}`);
}

async function sequence(id: string): Promise<string> {
  const r = await fetch(`${HORIZON}/accounts/${id}`);
  if (!r.ok) throw new Error(`load account ${r.status}`);
  return ((await r.json()) as { sequence: string }).sequence;
}

async function submit(kp: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
  const builder = new TransactionBuilder(
    new Account(kp.publicKey(), await sequence(kp.publicKey())),
    {
      fee: "1000",
      networkPassphrase: Networks.TESTNET,
    }
  ).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const r = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXDR("base64") }),
  });
  const body = (await r.json()) as { successful?: boolean; extras?: { result_codes?: unknown } };
  if (!r.ok || !body.successful) {
    throw new Error(`tx failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
}

const issuer = Keypair.random();
const mm = Keypair.random();
const LWDEMO = new Asset("LWDEMO", issuer.publicKey());

log(`Issuer (LWDEMO): ${issuer.publicKey()}`);
log(`Market maker:    ${mm.publicKey()}\n`);

log("Funding issuer + market maker via friendbot...");
await Promise.all([fund(issuer.publicKey()), fund(mm.publicKey())]);

log("MM: trustline + sell 5000 XLM for LWDEMO @ 2 LWDEMO/XLM...");
await submit(mm, [
  Operation.changeTrust({ asset: LWDEMO }),
  Operation.manageSellOffer({
    selling: Asset.native(),
    buying: LWDEMO,
    amount: "5000",
    price: "2",
  }),
]);

log("Issuer: sending 1,000,000 LWDEMO to the market maker...");
await submit(issuer, [
  Operation.payment({ destination: mm.publicKey(), asset: LWDEMO, amount: "1000000" }),
]);

log("\n✓ Playground accounts ready on TESTNET.\n");
log("Add these to .env.local (all server-only; never commit them):\n");
log(`PLAYGROUND_ISSUER_SECRET_TESTNET=${issuer.secret()}`);
log(`PLAYGROUND_MM_SECRET_TESTNET=${mm.secret()}`);
log(`PLAYGROUND_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
