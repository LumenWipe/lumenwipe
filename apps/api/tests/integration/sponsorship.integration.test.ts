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
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";
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

// Mirror of readAccountStateUntilSponsoring but for the opposite direction: after a real
// REVOKE_SPONSORSHIP submission, RPC's ingestion lag can still report the trustline as
// sponsored for a few seconds even though Horizon already confirmed the revoke. Polls
// for the specific entry to disappear rather than a flat sleep, same rationale as above.
async function readAccountStateUntilTrustlineNotSponsored(
  publicKey: string,
  owner: string,
  asset: string
): Promise<AccountState> {
  let lastState: AccountState | null = null;
  for (let attempt = 0; attempt < ACCOUNT_STATE_POLL_MAX_ATTEMPTS; attempt++) {
    lastState = await getAccountState(publicKey, "testnet");
    const stillSponsored = lastState.sponsoredEntries.some(
      (entry) => entry.kind === "trustline" && entry.owner === owner && entry.asset === asset
    );
    if (!stillSponsored) return lastState;
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_STATE_POLL_DELAY_MS));
  }
  // Out of attempts: return the last read so the assertion below reports the real
  // mismatch (e.g. genuinely stuck) rather than masking it behind a retry error.
  return lastState!;
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

test.skipIf(!RUN_INTEGRATION)(
  "assessSponsorshipAffordability + revokeSponsorshipOps › revoking a real sponsored trustline on testnet clears the sponsorship",
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
    const asset = new Asset("LWTEST2", issuer.publicKey());
    const assetString = `LWTEST2:${issuer.publicKey()}`;

    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const setupTx = new TransactionBuilder(sponsorAccount, {
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
    setupTx.sign(sponsor);
    setupTx.sign(sponsored);
    await server.submitTransaction(setupTx);

    const state = await readAccountStateUntilSponsoring(sponsor.publicKey());
    expect(state.sponsoredEntries).toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: assetString,
    });

    // This is the function under test (Task 3): re-reads live on-chain reserve state for
    // the sponsored owner and decides whether shifting the reserve back is affordable.
    const affordability = await assessSponsorshipAffordability(
      sponsor.publicKey(),
      state.sponsoredEntries,
      "testnet"
    );
    expect(affordability.revocable).toHaveLength(1);
    expect(affordability.unaffordableOwners.size).toBe(0);

    // This is the function under test (Task 4): builds the real REVOKE_SPONSORSHIP op(s).
    const ops = revokeSponsorshipOps(affordability.revocable);
    expect(ops).toHaveLength(1);

    // Re-load rather than reuse sponsorAccount: its sequence number is stale after
    // submitting setupTx above.
    const freshSponsorAccount = await server.loadAccount(sponsor.publicKey());
    const revokeTx = new TransactionBuilder(freshSponsorAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(ops[0])
      .setTimeout(60)
      .build();
    revokeTx.sign(sponsor);
    const result = await server.submitTransaction(revokeTx);
    expect(result.successful).toBe(true);

    // Fresh read (not the pre-revoke `state` above, and not readAccountStateUntilSponsoring,
    // which polls FOR numSponsoring >= 1 - the opposite of what should be true now): confirm
    // the sponsored account has absorbed its own reserve and the trustline no longer shows up
    // as sponsored by `sponsor`.
    const after = await readAccountStateUntilTrustlineNotSponsored(
      sponsor.publicKey(),
      sponsored.publicKey(),
      assetString
    );
    expect(after.sponsoredEntries).not.toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: assetString,
    });
  },
  120000
);
