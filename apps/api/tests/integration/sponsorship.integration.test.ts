// Must stay the first import, exactly as in src/main.ts: config/networks.ts reads
// process.env in top-level const initializers at import time. Bun does not auto-load
// .env.local when NODE_ENV=test (which `bun test` sets), so without this the
// Horizon-compatible base URL is "" and enumeration reports incomplete for every
// account regardless of what is really on chain.
import "@/env";
import { test, expect } from "bun:test";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";
import { getAccountState } from "@/lib/stellar/account";
import type { AccountState } from "@lumenwipe/types";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

// The public Soroban RPC testnet endpoint is load-balanced across nodes that lag
// each other and lag Horizon (see the ACCOUNT_VISIBILITY_* comment in
// src/config/constants.ts for the same phenomenon on a different call path). A
// transaction Horizon has already confirmed as successful may briefly read back
// from getAccountState as not-yet-sponsoring (numSponsoring: 0), or even throw
// AccountNotFoundError for an account Horizon already shows as funded, until RPC
// catches up. ~20s of total patience observed sufficient during manual testnet runs.
const ACCOUNT_STATE_POLL_MAX_ATTEMPTS = 8;
const ACCOUNT_STATE_POLL_DELAY_MS = 2500;

// This test funds real testnet accounts and submits a real transaction. The package's
// `test` script scopes itself to tests/unit + tests/e2e, but a bare `bun test` (an easy
// mistake in this repo - CLAUDE.md warns about it) globs **/*.test.ts and would pick
// this up. Only `bun run test:integration` sets the opt-in flag.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

// Retries getAccountState until numSponsoring reflects the just-submitted sponsorship
// (or the attempt cap is hit), absorbing Soroban RPC's ingestion lag. Also retries
// through a transient AccountNotFoundError, which real testnet runs of this test have
// shown RPC can throw for an account Horizon already confirms exists.
async function readAccountStateUntilSponsoring(publicKey: string): Promise<AccountState> {
  let lastState: AccountState | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < ACCOUNT_STATE_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      lastState = await getAccountState(publicKey, "testnet");
      if (lastState.numSponsoring >= 1) return lastState;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_STATE_POLL_DELAY_MS));
  }
  // Out of attempts: return the last successful read (if any) so the assertions
  // below report the real mismatch, rather than masking it behind a retry error.
  if (lastState) return lastState;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test.skipIf(!RUN_INTEGRATION)(
  "getAccountState › reports a real sponsored trustline created on testnet",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const sponsor = Keypair.random();
    const sponsored = Keypair.random();
    const issuer = Keypair.random();

    await Promise.all([
      fund(sponsor.publicKey()),
      fund(sponsored.publicKey()),
      fund(issuer.publicKey()),
    ]);
    const asset = new Asset("LWTEST", issuer.publicKey());

    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const tx = new TransactionBuilder(sponsorAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: sponsored.publicKey(),
          source: sponsor.publicKey(),
        })
      )
      .addOperation(Operation.changeTrust({ asset, source: sponsored.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }))
      .setTimeout(60)
      .build();
    tx.sign(sponsor);
    tx.sign(sponsored);
    await server.submitTransaction(tx);

    // Soroban RPC indexing lag for the account this test's assertions read through -
    // poll rather than a flat sleep, since observed lag varies run to run.
    const state = await readAccountStateUntilSponsoring(sponsor.publicKey());

    expect(state.numSponsoring).toBe(1);
    expect(state.sponsorshipEnumerationIncomplete).toBe(false);
    expect(state.sponsoredEntries).toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: `LWTEST:${issuer.publicKey()}`,
    });
  },
  60000
);
