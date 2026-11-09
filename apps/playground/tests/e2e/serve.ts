import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { LWDEMO_CODE } from "../../lib/scenarios";
import { fundTestnetAccount, HORIZON } from "./testnet";

// The e2e suite's playground server. It creates the playground's persistent testnet accounts for
// this run only - an LWDEMO issuer and a market maker, both Friendbot-funded, with the market
// maker trusting LWDEMO so it can post the liquidity offer the close converts against - plus a
// fresh encryption key, then starts `next dev` with them in its environment.
//
// The keys exist only in this process and the server it spawns: they are never printed, written
// to a file or passed back to the runner, and they are discarded with the run. No repository
// secret is involved, and the hosted playground's accounts are never used.
//
// `next dev` rather than `next start`: a production server refuses to run the session store
// without Upstash Redis, and the suite has none, so it uses the dev file store. The Upstash
// variables are blanked so a developer's own .env.local cannot point the suite at a real store.

const PORT = "3002";

async function trustLwdemo(mm: Keypair, issuerPublic: string): Promise<void> {
  const server = new Horizon.Server(HORIZON);
  const account = await server.loadAccount(mm.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset(LWDEMO_CODE, issuerPublic) }))
    .setTimeout(60)
    .build();
  tx.sign(mm);
  await server.submitTransaction(tx);
}

async function main(): Promise<void> {
  const issuer = Keypair.random();
  const mm = Keypair.random();
  await Promise.all([fundTestnetAccount(issuer.publicKey()), fundTestnetAccount(mm.publicKey())]);
  await trustLwdemo(mm, issuer.publicKey());
  console.log("[playground e2e] per-run issuer and market maker funded", {
    issuer: issuer.publicKey(),
    mm: mm.publicKey(),
  });

  const child = spawn(process.execPath, ["run", "next", "dev", "-p", PORT], {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYGROUND_ISSUER_SECRET_TESTNET: issuer.secret(),
      PLAYGROUND_MM_SECRET_TESTNET: mm.secret(),
      PLAYGROUND_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((err: unknown) => {
  console.error("[playground e2e] could not prepare the testnet accounts:", err);
  process.exit(1);
});
