import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import type { NativeBalance } from "./horizon-submit";
import { MM_KEEP_XLM } from "./standing-liquidity";
import type { FaucetFailure, SessionStore } from "./session-store";
import { networkStroops } from "./stroops";

// The market maker funds every demo account and takes it back at the merge. Only the reaper calls
// the public faucet, to top the market maker up; a visitor's request never waits on it.

/** Below this much spendable XLM the market maker funds no new session. */
export const MM_SESSION_FLOOR_XLM = 500;
/** Below this much spendable XLM the reaper tops the market maker up. */
export const MM_TOP_UP_BELOW_XLM = 5000;

/** XLM the market maker can send: its balance less what its offers have committed and its keep. */
export function spendableXlm({ balance, sellingLiabilities }: NativeBalance): number {
  const free = networkStroops(balance) - networkStroops(sellingLiabilities);
  return Number(free) / 10_000_000 - MM_KEEP_XLM;
}

export type FaucetOutcome = "funded" | FaucetFailure;

/** 429 is the faucet's rate limit; any other refusal, an outage or no answer at all is unavailable. */
export function faucetOutcome(status: number): FaucetOutcome {
  if (status >= 200 && status < 300) return "funded";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

const FRIENDBOT = "https://friendbot.stellar.org";
const FAUCET_TIMEOUT_MS = 30_000;

/** Asks Friendbot to create and fund `publicKey`. */
export async function callFriendbot(publicKey: string): Promise<FaucetOutcome> {
  try {
    const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FAUCET_TIMEOUT_MS),
    });
    return faucetOutcome(res.status);
  } catch {
    return "unavailable";
  }
}

export interface TopUpDeps {
  store: SessionStore;
  mmPublic: string;
  /** Creates and funds a new account; Friendbot cannot fund one that already exists. */
  faucet: (publicKey: string) => Promise<FaucetOutcome>;
  /** Merges `source` into `destination`. */
  merge: (source: Keypair, destination: string) => Promise<unknown>;
}

export type TopUpResult = FaucetOutcome | "merge_failed";

/**
 * Funds a throwaway account from the faucet and merges it into the market maker. The throwaway's
 * key exists only in this call; a failed merge strands its XLM and is logged by public key, and the
 * faucet is not asked again in the same run.
 */
export async function topUpMarketMaker(deps: TopUpDeps): Promise<TopUpResult> {
  const throwaway = Keypair.random();
  const outcome = await deps.faucet(throwaway.publicKey());
  await deps.store.recordFaucetFailure(outcome === "funded" ? null : outcome).catch(() => {
    console.error("[playground] market maker top-up: faucet outcome not recorded", { outcome });
  });
  if (outcome !== "funded") {
    console.warn("[playground] market maker top-up: faucet refused", { outcome });
    return outcome;
  }
  try {
    await deps.merge(throwaway, deps.mmPublic);
    return "funded";
  } catch (err) {
    console.error(
      "[playground] market maker top-up: merge failed",
      { throwaway: throwaway.publicKey(), outcome: "merge_failed" },
      err instanceof Error ? err.name : "unknown"
    );
    return "merge_failed";
  }
}

export class AccountBusyError extends Error {
  constructor() {
    super("Another submission from this account is still running");
    this.name = "AccountBusyError";
  }
}

/** Longer than one submission takes, so a holder the platform kills frees the account soon after. */
const ACCOUNT_LEASE_TTL_MS = 60_000;
const ACCOUNT_LEASE_WAIT_MS = 15_000;
const ACCOUNT_LEASE_POLL_MS = 250;

export interface AccountLockOptions {
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Runs `fn` while holding the account's lease, so concurrent requests submit from one account one
 * at a time instead of racing for its sequence number. The network still enforces the sequence, so
 * a holder that outlives its lease costs a retry, never a wrong transaction.
 */
export async function withAccountLock<T>(
  store: SessionStore,
  account: string,
  fn: () => Promise<T>,
  opts: AccountLockOptions = {}
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? ACCOUNT_LEASE_WAIT_MS);
  const name = `account:${account}`;
  let lease = await store.acquireLease(name, ACCOUNT_LEASE_TTL_MS);
  while (!lease) {
    if (now() >= deadline) throw new AccountBusyError();
    await sleep(opts.pollMs ?? ACCOUNT_LEASE_POLL_MS);
    lease = await store.acquireLease(name, ACCOUNT_LEASE_TTL_MS);
  }
  try {
    return await fn();
  } finally {
    await store.releaseLease(lease).catch(() => undefined);
  }
}
