import type {
  Allowance,
  AllowanceCoverage,
  AllowanceSource,
  AllowancesResult,
} from "@lumenwipe/types";
import type { Network } from "@/config/networks";
import {
  Account,
  Address,
  Contract,
  StrKey,
  TransactionBuilder,
  rpc as stellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { entriesForNetwork, type ContractRegistryEntry } from "@/lib/contract-registry";
import { mapConcurrent } from "@/lib/utils/concurrency";
import { bundledListCandidates } from "./soroban-tokens";
import { getRpcServer } from "./rpc";

/**
 * The allowance inspector's read side (architecture.md §12, #162): every live, non-zero SEP-41
 * allowance an account has granted. `approve(from, spender, amount, expiration_ledger)` has no
 * on-chain index by owner, so - the same shape of problem as Soroban token balances
 * (soroban-tokens.ts) - discovery is a union of candidate (token, spender) pairs, confirmed by
 * reading `allowance(from, spender)` on the ledger:
 *
 *  - recent `approve` events naming this account as `from`, scanned in bounded windows exactly
 *    like soroban-tokens.ts's credit-event scan, each directly naming its own token (the emitting
 *    contract) and spender (the event's own topic);
 *  - the known DeFi contract registry's spenders (#152's shared registry, not a second one),
 *    crossed with a small curated list of well-known Soroban tokens - this is what still finds an
 *    approval old enough that its `approve` event has aged out of the event scan's retention
 *    window, at the cost of not knowing that approval's expiration ledger (SEP-41's `allowance()`
 *    returns only the amount, never the expiration - only the discovering `approve` event's own
 *    data carries that).
 *
 * The amount is always the live read, never the event's: `approve` sets an explicit value rather
 * than decrementing on spend, so an old event's amount can be stale in either direction. A zero
 * live allowance is not reported - only what is actually outstanding right now.
 */

export interface AllowanceRpc {
  simulateTransaction: stellarRpc.Server["simulateTransaction"];
  getEvents: stellarRpc.Server["getEvents"];
  getLatestLedger: stellarRpc.Server["getLatestLedger"];
}

export interface AllowancesDeps {
  rpc: AllowanceRpc;
  now: () => number;
  /** Total time the discovery may take; what does not fit is reported as skipped. */
  budgetMs: number;
  /** The known DeFi contract registry's entries for this network - injected, like
   *  soroban-tokens.ts's `listCandidates`, so a test can hand a small fixed set instead of
   *  fighting the real shipped registry's size. */
  registryEntries: ContractRegistryEntry[];
  /** A small curated list of well-known Soroban tokens, crossed with `registryEntries`' spenders
   *  to widen candidates beyond what the event scan alone can see. */
  knownTokens: string[];
}

/** Discovery never holds a request longer than this. */
export const ALLOWANCES_BUDGET_MS = 20_000;
/** The public RPC refuses `getEvents` windows much wider than this under its processing cap. */
export const EVENTS_CHUNK_LEDGERS = 4_000;
/** At most this many chunks per request (about 33 hours on mainnet). */
export const EVENTS_MAX_CHUNKS = 6;
export const EVENTS_PAGE_LIMIT = 1_000;
export const EVENTS_MAX_PAGES = 5;
/** Candidate (token, spender) pairs a single source may contribute. */
export const MAX_CANDIDATES_PER_SOURCE = 50;
/** No more pairs than this are read per request; the rest are reported as skipped. */
export const MAX_CANDIDATES = 50;
export const ALLOWANCE_CONCURRENCY = 8;
export const ALLOWANCE_TIMEOUT_MS = 5_000;
const LEDGER_READS_RESERVE_MS = 6_000;
const RPC_CALL_TIMEOUT_MS = 12_000;

export function defaultAllowancesDeps(
  network: Network,
  options: { budgetMs?: number } = {}
): AllowancesDeps {
  return {
    rpc: getRpcServer(network),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? ALLOWANCES_BUDGET_MS,
    registryEntries: entriesForNetwork(network),
    knownTokens: bundledListCandidates(network),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A printable, checksum-valid address decoded from an ScVal, or null - a hostile or malformed
 *  event must surface as "no candidate found here", never throw the whole scan. */
function decodeAddress(val: xdr.ScVal | undefined): string | null {
  if (!val) return null;
  try {
    const native: unknown = scValToNative(val);
    return typeof native === "string" &&
      (StrKey.isValidEd25519PublicKey(native) || StrKey.isValidContract(native))
      ? native
      : null;
  } catch {
    return null;
  }
}

/** `approve`'s event data is `[amount, live_until_ledger]` (SEP-41); only the expiration is taken
 *  from it, decoded defensively since the shape is a third party's to get wrong. */
function decodeExpirationLedger(val: xdr.ScVal): number | null {
  try {
    const native: unknown = scValToNative(val);
    if (!Array.isArray(native) || native.length < 2) return null;
    const ledger = native[1];
    if (typeof ledger === "number" && Number.isInteger(ledger) && ledger >= 0) return ledger;
    if (typeof ledger === "bigint" && ledger >= 0n && ledger <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(ledger);
    }
    return null;
  } catch {
    return null;
  }
}

function approveTopicFilter(address: string): string[][] {
  const who = new Address(address).toScVal().toXDR("base64");
  return [[xdr.ScVal.scvSymbol("approve").toXDR("base64"), who, "*"]];
}

interface ApprovePair {
  token: string;
  spender: string;
  ledger: number;
  expirationLedger: number | null;
}

interface ApproveEventScan {
  pairs: Map<string, ApprovePair>;
  scanned: { fromLedger: number; toLedger: number } | null;
  stoppedEarly: string | null;
}

/** Recent `approve` events naming this account as `from`, newest window first, in chunks the RPC
 *  can process - the same scanning shape as soroban-tokens.ts's `eventCandidates`, tracking the
 *  highest-ledger event per (token, spender) pair rather than just presence, since a later
 *  `approve` (including a revoke, which is `approve(..., 0, ...)`) on the same pair supersedes an
 *  earlier one's expiration. */
async function approveEventCandidates(
  address: string,
  deps: AllowancesDeps,
  deadline: number
): Promise<ApproveEventScan> {
  const latest = (
    await withTimeout(
      deps.rpc.getLatestLedger(),
      Math.max(1, Math.min(deadline - deps.now(), RPC_CALL_TIMEOUT_MS)),
      "getLatestLedger"
    )
  ).sequence;
  const filters: stellarRpc.Api.EventFilter[] = [
    { type: "contract", topics: approveTopicFilter(address) },
  ];
  const pairs = new Map<string, ApprovePair>();
  let scanned: { fromLedger: number; toLedger: number } | null = null;
  let stoppedEarly: string | null = null;
  for (let chunk = 0; chunk < EVENTS_MAX_CHUNKS; chunk++) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      stoppedEarly = "time budget";
      break;
    }
    const endLedger = latest - chunk * EVENTS_CHUNK_LEDGERS;
    const startLedger = Math.max(1, endLedger - EVENTS_CHUNK_LEDGERS + 1);
    if (endLedger < 1) break;
    let cursor: string | undefined;
    try {
      for (let pages = 0; pages < EVENTS_MAX_PAGES; pages++) {
        const left = deadline - deps.now();
        if (left <= 0) throw new Error("time budget");
        const page = await withTimeout(
          deps.rpc.getEvents(
            cursor === undefined
              ? { startLedger, endLedger, filters, limit: EVENTS_PAGE_LIMIT }
              : { cursor, filters, limit: EVENTS_PAGE_LIMIT }
          ),
          Math.min(left, RPC_CALL_TIMEOUT_MS),
          "getEvents"
        );
        let pastChunk = false;
        for (const event of page.events) {
          if (event.ledger > endLedger) {
            pastChunk = true;
            break;
          }
          const token = event.contractId?.contractId();
          const spender = decodeAddress(event.topic[2]);
          if (token && spender) {
            const key = `${token}:${spender}`;
            const existing = pairs.get(key);
            if (!existing || event.ledger > existing.ledger) {
              pairs.set(key, {
                token,
                spender,
                ledger: event.ledger,
                expirationLedger: decodeExpirationLedger(event.value),
              });
            }
          }
          if (pairs.size >= MAX_CANDIDATES_PER_SOURCE) break;
        }
        if (pastChunk || pairs.size >= MAX_CANDIDATES_PER_SOURCE) break;
        if (page.events.length < EVENTS_PAGE_LIMIT || !page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
    } catch (err) {
      stoppedEarly = reason(err);
      break;
    }
    scanned = { fromLedger: startLedger, toLedger: latest };
    if (startLedger === 1) break;
  }
  return { pairs, scanned, stoppedEarly };
}

/** Sources in the order their candidates are kept when the cap bites: an `approve` event is
 *  ground truth for a specific pair, so it is never dropped ahead of a registry-widened guess. */
const SOURCE_PRIORITY: AllowanceSource[] = ["events", "registry"];

interface PairCandidate {
  token: string;
  spender: string;
  sources: Set<AllowanceSource>;
  expirationLedger: number | null;
}

class PairCandidates {
  private readonly pairs = new Map<string, PairCandidate>();
  add(
    token: string,
    spender: string,
    source: AllowanceSource,
    expirationLedger: number | null = null
  ): void {
    if (!StrKey.isValidContract(token) || !StrKey.isValidContract(spender)) return;
    const key = `${token}:${spender}`;
    let entry = this.pairs.get(key);
    if (!entry) {
      entry = { token, spender, sources: new Set(), expirationLedger: null };
      this.pairs.set(key, entry);
    }
    entry.sources.add(source);
    if (expirationLedger !== null) entry.expirationLedger = expirationLedger;
  }
  ordered(): PairCandidate[] {
    const rank = (sources: Set<AllowanceSource>): number =>
      Math.min(...[...sources].map((s) => SOURCE_PRIORITY.indexOf(s)));
    return [...this.pairs.values()].sort((a, b) => rank(a.sources) - rank(b.sources));
  }
}

/** A read-only call on a token, by simulation; null when the token does not answer it. */
async function simulateRead(
  rpc: AllowanceRpc,
  network: Network,
  account: string,
  token: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const tx = new TransactionBuilder(new Account(account, "0"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASES[network],
  })
    .addOperation(new Contract(token).call(fn, ...args))
    .setTimeout(30)
    .build();
  const response = await rpc.simulateTransaction(tx);
  const simulation = stellarRpc.Api.isSimulationRaw(response)
    ? stellarRpc.parseRawSimulation(response)
    : response;
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) return null;
  return simulation.result?.retval ?? null;
}

const asBigInt = (val: xdr.ScVal | null): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isInteger(native)) return BigInt(native);
  return null;
};

function printableSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32 && /^[\x20-\x7e]+$/.test(trimmed)
    ? trimmed
    : null;
}

type Read =
  | { status: "allowed"; amount: bigint; symbol: string | null }
  | { status: "none" }
  | { status: "unreadable"; detail: string };

async function readAllowance(
  owner: string,
  candidate: PairCandidate,
  network: Network,
  rpc: AllowanceRpc,
  now: () => number,
  deadline: number
): Promise<Read> {
  const readTimeout = (): number => Math.min(ALLOWANCE_TIMEOUT_MS, deadline - now());
  if (readTimeout() <= 0) return { status: "unreadable", detail: "time budget" };
  try {
    const amount = asBigInt(
      await withTimeout(
        simulateRead(
          rpc,
          network,
          owner,
          candidate.token,
          "allowance",
          new Address(owner).toScVal(),
          new Address(candidate.spender).toScVal()
        ),
        readTimeout(),
        "allowance"
      )
    );
    if (amount === null) return { status: "unreadable", detail: "allowance() did not answer" };
    if (amount <= 0n) return { status: "none" };
    if (readTimeout() <= 0) return { status: "allowed", amount, symbol: null };
    const symbolVal = await withTimeout(
      simulateRead(rpc, network, owner, candidate.token, "symbol"),
      readTimeout(),
      "symbol"
    ).catch(() => null);
    const symbol = printableSymbol(
      (() => {
        try {
          return symbolVal ? scValToNative(symbolVal) : null;
        } catch {
          return null;
        }
      })()
    );
    return { status: "allowed", amount, symbol };
  } catch (err) {
    return { status: "unreadable", detail: reason(err) };
  }
}

/**
 * Every live allowance the account has granted, best effort, with what was and was not
 * consulted. Never throws: a source that fails is reported in `coverage` and as a warning.
 */
export async function discoverAllowances(
  address: string,
  network: Network,
  deps: AllowancesDeps
): Promise<AllowancesResult> {
  const started = deps.now();
  const deadline = started + deps.budgetMs;
  const coverage: AllowanceCoverage[] = [];
  const warnings: AllowancesResult["warnings"] = [];

  const candidates = new PairCandidates();
  const registryEntries = deps.registryEntries;

  const eventScan = await approveEventCandidates(
    address,
    deps,
    deadline - LEDGER_READS_RESERVE_MS
  ).catch((err: unknown) => {
    coverage.push({ source: "events", status: "failed", detail: reason(err) });
    return null;
  });
  let eventsScanned: { fromLedger: number; toLedger: number } | null = null;
  if (eventScan) {
    for (const pair of eventScan.pairs.values()) {
      candidates.add(pair.token, pair.spender, "events", pair.expirationLedger);
    }
    coverage.push({
      source: "events",
      status: eventScan.scanned ? "ok" : "failed",
      ...(eventScan.stoppedEarly ? { detail: eventScan.stoppedEarly } : {}),
    });
    eventsScanned = eventScan.scanned;
  }

  if (registryEntries.length > 0) {
    const knownTokens = deps.knownTokens;
    for (const entry of registryEntries) {
      for (const token of knownTokens) candidates.add(token, entry.address, "registry");
    }
    coverage.push({ source: "registry", status: "ok" });
  } else {
    coverage.push({
      source: "registry",
      status: "skipped",
      detail: "no registry entries for this network",
    });
  }

  const ordered = candidates.ordered();
  const kept = ordered.slice(0, MAX_CANDIDATES);
  if (ordered.length > kept.length) {
    warnings.push({
      code: "allowances_capped",
      message:
        `${ordered.length - kept.length} possible (token, spender) pair(s) were not checked: at ` +
        `most ${MAX_CANDIDATES} are read per request.`,
    });
  }

  const reads = await mapConcurrent(kept, ALLOWANCE_CONCURRENCY, (candidate) =>
    readAllowance(address, candidate, network, deps.rpc, deps.now, deadline)
  );

  const allowances: Allowance[] = [];
  const unreadable: PairCandidate[] = [];
  kept.forEach((candidate, i) => {
    const result = reads[i]!;
    if (result.status === "allowed") {
      allowances.push({
        token: candidate.token,
        tokenSymbol: result.symbol,
        spender: candidate.spender,
        spenderProtocol:
          registryEntries.find((e) => e.address === candidate.spender)?.protocol ?? null,
        amount: result.amount.toString(),
        expirationLedger: candidate.expirationLedger,
        sources: SOURCE_PRIORITY.filter((s) => candidate.sources.has(s)),
      });
    } else if (result.status === "unreadable") {
      unreadable.push(candidate);
    }
  });

  if (unreadable.length > 0) {
    warnings.push({
      code: "allowances_unreadable",
      message:
        `${unreadable.length} candidate token/spender pair(s) did not answer allowance() and ` +
        "could not be checked. An outstanding approval there would not be shown here.",
    });
  }

  allowances.sort((a, b) => a.token.localeCompare(b.token) || a.spender.localeCompare(b.spender));
  return { allowances, coverage, eventsScanned, warnings };
}
