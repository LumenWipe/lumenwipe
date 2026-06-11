/**
 * Generates and funds a shared mediator account on Stellar TESTNET via friendbot,
 * then prints the env vars to configure. For testnet/dev only - for mainnet,
 * generate the keypair offline and fund it from a real account.
 *
 *   bun scripts/setup-mediator.ts
 */
import { Keypair } from "@stellar/stellar-sdk";

const FRIENDBOT = "https://friendbot.stellar.org";

const kp = Keypair.random();

process.stdout.write(`Funding ${kp.publicKey()} on testnet via friendbot...\n`);
const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(kp.publicKey())}`);
if (!res.ok) {
  process.stderr.write(`Friendbot funding failed (${res.status}): ${await res.text()}\n`);
  process.exit(1);
}

process.stdout.write("\n✓ Shared mediator funded on TESTNET.\n\n");
process.stdout.write("Add these to .env.local (the secret is server-only; never commit it):\n\n");
process.stdout.write(`NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET=${kp.publicKey()}\n`);
process.stdout.write(`MEDIATOR_SECRET_TESTNET=${kp.secret()}\n`);
