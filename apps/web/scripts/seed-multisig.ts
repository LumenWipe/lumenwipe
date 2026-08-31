/**
 * Seeds a 2-of-3 account for the multisig recording (SCF T1, deliverable 4).
 *
 * The criterion asks for "a 2-of-3 multisig account closed on testnet using two different
 * wallets", so the two co-signers cannot be keys this script invents - they have to be
 * addresses the recorder already controls in two real wallets.
 *
 *   bun run apps/web/scripts/seed-multisig.ts <freighter-address> <xbull-address>
 *
 * The account ends up with three signers of weight 1 (its own master key plus the two wallets)
 * and thresholds low 1 / med 2 / high 2. The close is a single high-threshold transaction -
 * signer removal plus the merge - so the two wallets together satisfy it and the master key
 * never signs. That is what makes the demo two wallets rather than one wallet and a secret.
 *
 * Master weight stays at 1 on purpose: at 0 the plan refuses outright, because removing the
 * other signers would leave the account with nothing able to authorise anything ever again.
 */

import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000";

const SIGNERS_POLL_MAX_ATTEMPTS = 8;
const SIGNERS_POLL_DELAY_MS = 2_500;

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

/** Horizon can lag the transaction that configured the signers, and the app reads through it -
 *  so confirm the new signer set is visible before handing over the address. */
async function waitForThreeSigners(id: string): Promise<void> {
  for (let attempt = 0; attempt < SIGNERS_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${HORIZON}/accounts/${id}`);
    if (res.ok) {
      const account = (await res.json()) as { signers: unknown[] };
      if (account.signers.length === 3) return;
    }
    await new Promise((r) => setTimeout(r, SIGNERS_POLL_DELAY_MS));
  }
  throw new Error(`timed out waiting for ${id} to show 3 signers`);
}

async function configureTwoOfThree(master: Keypair, walletB: string, walletC: string) {
  const tx = new TransactionBuilder(
    new Account(master.publicKey(), await loadSequence(master.publicKey())),
    { fee: BASE_FEE, networkPassphrase: PASSPHRASE }
  )
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: walletB, weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: walletC, weight: 1 } }))
    .addOperation(Operation.setOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(120)
    .build();
  tx.sign(master);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXDR("base64") }),
  });
  const body = (await res.json()) as { successful?: boolean; extras?: { result_codes?: unknown } };
  if (!res.ok || !body.successful) {
    throw new Error(`configure failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
  await waitForThreeSigners(master.publicKey());
}

async function main(): Promise<void> {
  const [walletB, walletC] = process.argv.slice(2);

  if (!walletB || !walletC) {
    console.error(
      "\n  Usage: bun run apps/web/scripts/seed-multisig.ts <freighter-address> <xbull-address>\n\n" +
        "  Both must be G... addresses you can actually sign with in those two wallets -\n" +
        "  the point of the deliverable is two different wallets, not two keys.\n"
    );
    process.exit(1);
  }
  for (const [label, addr] of [
    ["first wallet", walletB],
    ["second wallet", walletC],
  ] as const) {
    if (!StrKey.isValidEd25519PublicKey(addr)) {
      throw new Error(`the ${label} address is not a valid G... public key: ${addr}`);
    }
  }
  if (walletB === walletC) {
    throw new Error("both addresses are the same - the demo needs two different wallets");
  }

  const master = Keypair.random();
  const destination = Keypair.random();

  console.log("\nSeeding a 2-of-3 account on TESTNET\n");

  log("Funding the account and destination…");
  await Promise.all([fund(master.publicKey()), fund(destination.publicKey())]);
  log("  funded");

  log("Adding both wallets as signers…");
  await configureTwoOfThree(master, walletB, walletC);
  log("  signers", "3 × weight 1  ·  thresholds 1 / 2 / 2");

  const bar = "─".repeat(78);
  console.log(`\n${bar}\n  READY TO RECORD\n${bar}\n`);
  console.log(`    Source account   ${master.publicKey()}`);
  console.log(`    XLM destination  ${destination.publicKey()}`);
  console.log(`\n  Signers on the account\n`);
  console.log(`    master (unused)  ${master.publicKey()}  weight 1`);
  console.log(`    wallet 1         ${walletB}  weight 1`);
  console.log(`    wallet 2         ${walletC}  weight 1`);
  console.log(`\n  The close needs weight 2, so the two wallets satisfy it together and the`);
  console.log(`  master key is never used. Sign with one wallet, switch, sign with the other.`);
  console.log(`\n  Verify afterwards on stellar.expert (testnet)\n`);
  console.log(
    `    source gone      https://stellar.expert/explorer/testnet/account/${master.publicKey()}`
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
