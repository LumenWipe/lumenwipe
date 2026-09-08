import type {
  DefiPosition,
  Network,
  PlanBlocker,
  SorobanTokenBalance,
  SorobanTokenCoverage,
  SorobanTokenSource,
  SorobanTokensResult,
} from "@lumenwipe/types";
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
import { NETWORK_PASSPHRASES, STELLAR_EXPERT_API_URL } from "@/config/networks";
import bundledLists from "@/config/soroban-token-lists.json";
import { mapConcurrent } from "@/lib/utils/concurrency";
import { getRpcServer } from "./rpc";

/**
 * Soroban (SEP-41) token balances an account holds directly - the tokens the close must decide
 * about that no classic read shows (architecture.md §10, #161).
 *
 * Soroban keeps every token balance in the token contract's own storage, keyed by holder; there
 * is no per-account index to enumerate, and the public RPC's `getEvents` has a processing cap
 * that makes scanning its seven-day retention infeasible on mainnet (a window past a few thousand
 * ledgers times out). So discovery is a union of candidate sources, and truth is the ledger:
 *
 *  - the stellar.expert API, the one free per-account listing of contract balances (a third party
 *    with an undocumented endpoint and indexer lag: it proposes, it never decides);
 *  - the tokens named by the account's detected DeFi positions (what an exit pays out);
 *  - bundled lists of Soroban-native tokens with known liquidity (the only ones convertible);
 *  - recent on-chain `transfer` and `mint` events crediting the account, scanned in bounded
 *    windows as a freshness supplement, not as the source of record;
 *  - contracts the user adds by hand.
 *
 * Every candidate is then confirmed by simulating `balance(account)` on the RPC - the
 * layout-agnostic read that works for any SEP-41 token - and its `symbol()` / `decimals()` are
 * read the same way. A Stellar asset's contract is excluded: for an account its balance IS the
 * classic trustline the state already carries. A candidate whose balance cannot be read is
 * reported as unreadable and becomes a warning, never a silent zero. Nothing here builds or signs.
 */

export interface SorobanTokenRpc {
  getLedgerEntries: stellarRpc.Server["getLedgerEntries"];
  simulateTransaction: stellarRpc.Server["simulateTransaction"];
  getEvents: stellarRpc.Server["getEvents"];
  getLatestLedger: stellarRpc.Server["getLatestLedger"];
}

export interface SorobanTokensDeps {
  rpc: SorobanTokenRpc;
  fetch: typeof fetch;
  /** stellar.expert API base; empty disables the explorer source. */
  explorerBaseUrl: string;
  /** Contracts the bundled lists know for this network. */
  listCandidates: string[];
  /** Contracts the user typed in; read like any other candidate. */
  manualCandidates: string[];
  /** Detected positions: their payout tokens are candidates, their share tokens are excluded. */
  positions: DefiPosition[];
  /** Wall clock, for the time budget. */
  now: () => number;
  /** Total time the discovery may take; what does not fit is reported as skipped. */
  budgetMs: number;
  /** Whether to scan recent events at all. A close round re-reads state several times and only
   *  needs the balances the analysis already named; the scan is for finding new ones. */
  scanEvents?: boolean;
}

/** Discovery never holds an analysis longer than this; sources that do not fit are skipped. */
export const SOROBAN_TOKENS_BUDGET_MS = 20_000;
/** The explorer answers in a few hundred milliseconds or not at all. */
export const EXPLORER_TIMEOUT_MS = 3_000;
/** The public RPC refuses `getEvents` windows much wider than this under its processing cap. */
export const EVENTS_CHUNK_LEDGERS = 4_000;
/** At most this many chunks per analysis (about 33 hours on mainnet). */
export const EVENTS_MAX_CHUNKS = 6;
export const EVENTS_PAGE_LIMIT = 1_000;
/** Pages read per chunk before the chunk is called covered enough; a busier account than this
 *  is a candidate flood the cap below would truncate anyway. */
export const EVENTS_MAX_PAGES = 5;
/** Candidates a single third-party or on-chain source may contribute; the rest are dropped there
 *  rather than crowding out the user's own and the positions' tokens under the overall cap. */
export const MAX_CANDIDATES_PER_SOURCE = 50;
/** No more candidates than this are read per analysis; the rest are reported as skipped. */
export const MAX_CANDIDATES = 50;
export const BALANCE_CONCURRENCY = 8;
export const BALANCE_TIMEOUT_MS = 5_000;
/** Reserved for the ledger reads after the sources: the event scan may use the budget up to here. */
const LEDGER_READS_RESERVE_MS = 6_000;
const RPC_CALL_TIMEOUT_MS = 12_000;
/** Ledger entries are read in chunks below the RPC's per-call key cap. */
const LEDGER_KEYS_PER_CALL = 100;

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

type Bundled = { mainnet: Array<{ contract: string }>; testnet: Array<{ contract: string }> };

export function bundledListCandidates(network: Network): string[] {
  return (bundledLists as Bundled)[network].map((t) => t.contract);
}

export function defaultSorobanTokensDeps(
  network: Network,
  positions: DefiPosition[],
  manualCandidates: string[] = [],
  options: { budgetMs?: number; scanEvents?: boolean } = {}
): SorobanTokensDeps {
  return {
    rpc: getRpcServer(network),
    fetch: globalThis.fetch,
    explorerBaseUrl: STELLAR_EXPERT_API_URL,
    listCandidates: bundledListCandidates(network),
    manualCandidates,
    positions,
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? SOROBAN_TOKENS_BUDGET_MS,
    scanEvents: options.scanEvents ?? true,
  };
}

/** Sources in the order their candidates are kept when the cap bites: the user's own first. */
const SOURCE_PRIORITY: SorobanTokenSource[] = ["manual", "positions", "explorer", "events", "list"];

class Candidates {
  private readonly sources = new Map<string, Set<SorobanTokenSource>>();
  constructor(private readonly excluded: Set<string>) {}
  add(contract: string, source: SorobanTokenSource): void {
    if (!CONTRACT_ID.test(contract) || !StrKey.isValidContract(contract)) return;
    if (this.excluded.has(contract)) return;
    let set = this.sources.get(contract);
    if (!set) {
      set = new Set();
      this.sources.set(contract, set);
    }
    set.add(source);
  }
  /** Candidates ordered by their best source, so a cap drops the least trusted first. */
  ordered(): Array<[string, SorobanTokenSource[]]> {
    const rank = (sources: Set<SorobanTokenSource>): number =>
      Math.min(...[...sources].map((s) => SOURCE_PRIORITY.indexOf(s)));
    return [...this.sources.entries()]
      .sort(([, a], [, b]) => rank(a) - rank(b))
      .map(([contract, sources]) => [contract, SOURCE_PRIORITY.filter((s) => sources.has(s))]);
  }
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

// ─── candidate sources ───────────────────────────────────────────────────────

/** stellar.expert's per-account value listing: every `C...` asset with a non-zero balance. */
async function explorerCandidates(
  address: string,
  network: Network,
  deps: SorobanTokensDeps
): Promise<string[]> {
  const segment = network === "mainnet" ? "public" : "testnet";
  const url = `${deps.explorerBaseUrl.replace(/\/$/, "")}/explorer/${segment}/account/${address}/value`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLORER_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await deps.fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    // An account the explorer has not indexed yet is not an error: it simply proposes nothing.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`explorer responded ${res.status}`);
    const body: unknown = await res.json();
    const balances =
      body && typeof body === "object" && Array.isArray((body as { balances?: unknown }).balances)
        ? ((body as { balances: unknown[] }).balances as unknown[])
        : [];
    const out: string[] = [];
    for (const entry of balances) {
      if (!entry || typeof entry !== "object") continue;
      const { asset, balance } = entry as { asset?: unknown; balance?: unknown };
      if (typeof asset !== "string" || !CONTRACT_ID.test(asset)) continue;
      if (typeof balance === "string" && /^0+$/.test(balance)) continue;
      out.push(asset);
      if (out.length >= MAX_CANDIDATES_PER_SOURCE) break;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** The topic shapes a credit to the account can take: SEP-41 `transfer` (3 topics), the Stellar
 *  Asset Contract's `transfer` (4, with the asset), SEP-41 `mint` (`[mint, to]`), the SAC's
 *  (`[mint, to, asset]`), and the older example-token `mint` that names the admin first
 *  (`[mint, admin, to]`). Five is the RPC's limit per filter. */
export function creditTopicFilters(address: string): string[][] {
  const who = new Address(address).toScVal().toXDR("base64");
  const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const mint = xdr.ScVal.scvSymbol("mint").toXDR("base64");
  return [
    [transfer, "*", who],
    [transfer, "*", who, "*"],
    [mint, who],
    [mint, who, "*"],
    [mint, "*", who],
  ];
}

interface EventScan {
  contracts: string[];
  scanned: { fromLedger: number; toLedger: number } | null;
  /** Set when the scan stopped before covering every chunk it was allowed. */
  stoppedEarly: string | null;
}

/** Recent credits to the account, newest window first, in chunks the RPC can process. */
async function eventCandidates(
  address: string,
  deps: SorobanTokensDeps,
  deadline: number
): Promise<EventScan> {
  const latest = (
    await withTimeout(
      deps.rpc.getLatestLedger(),
      Math.max(1, Math.min(deadline - deps.now(), RPC_CALL_TIMEOUT_MS)),
      "getLatestLedger"
    )
  ).sequence;
  const filters: stellarRpc.Api.EventFilter[] = [
    { type: "contract", topics: creditTopicFilters(address) },
  ];
  const contracts = new Set<string>();
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
      // Newest chunk first: a token received an hour ago matters more than one received yesterday.
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
        // A cursor request carries no endLedger, so a page may run past this chunk into ledgers
        // a later (newer) chunk already covered or a newer one will; stop at the chunk's edge.
        let pastChunk = false;
        for (const event of page.events) {
          if (event.ledger > endLedger) {
            pastChunk = true;
            break;
          }
          if (event.contractId) contracts.add(event.contractId.contractId());
          if (contracts.size >= MAX_CANDIDATES_PER_SOURCE) break;
        }
        if (pastChunk || contracts.size >= MAX_CANDIDATES_PER_SOURCE) break;
        if (page.events.length < EVENTS_PAGE_LIMIT || !page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
    } catch (err) {
      // A window the RPC will not serve (retention floor, processing cap, timeout) ends the scan;
      // what was covered still counts, and the gap is reported.
      stoppedEarly = reason(err);
      break;
    }
    // Chunks run newest first, so the covered range always ends at the latest ledger.
    scanned = { fromLedger: startLedger, toLedger: latest };
    if (startLedger === 1) break;
  }
  return { contracts: [...contracts], scanned, stoppedEarly };
}

// ─── ledger truth ────────────────────────────────────────────────────────────

/** Instances of the given contracts: which exist, and which are Stellar Asset Contracts. */
async function readInstances(
  contracts: string[],
  rpc: SorobanTokenRpc
): Promise<Map<string, { isStellarAsset: boolean }>> {
  const out = new Map<string, { isStellarAsset: boolean }>();
  for (let i = 0; i < contracts.length; i += LEDGER_KEYS_PER_CALL) {
    const slice = contracts.slice(i, i + LEDGER_KEYS_PER_CALL);
    const response = await rpc.getLedgerEntries(
      ...slice.map((c) => new Contract(c).getFootprint())
    );
    for (const entry of response.entries ?? []) {
      try {
        const contract = Address.fromScAddress(entry.key.contractData().contract()).toString();
        const executable = entry.val.contractData().val().instance().executable();
        out.set(contract, {
          isStellarAsset:
            executable.switch() === xdr.ContractExecutableType.contractExecutableStellarAsset(),
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** A read-only call on a token, by simulation; null when the token does not answer it. */
async function simulateRead(
  rpc: SorobanTokenRpc,
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

type Probe =
  | { status: "held"; balance: bigint; symbol: string | null; decimals: number | null }
  | { status: "empty"; symbol: string | null; decimals: number | null }
  | { status: "unreadable"; detail: string };

/** A symbol is presentation: only plain printable text is shown, anything else reads as none. */
function printableSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32 && /^[\x20-\x7e]+$/.test(trimmed)
    ? trimmed
    : null;
}

async function probe(
  token: string,
  account: string,
  network: Network,
  rpc: SorobanTokenRpc,
  now: () => number,
  deadline: number,
  /** Read symbol/decimals even for an empty balance (a payout token the close must ask about). */
  describeEmpty = false
): Promise<Probe> {
  const who = new Address(account).toScVal();
  // Each read gets its own timeout, never past the overall budget: a token that is never probed
  // because time ran out is unreadable for that reason, not silently absent.
  const readTimeout = (): number => Math.min(BALANCE_TIMEOUT_MS, deadline - now());
  if (readTimeout() <= 0) return { status: "unreadable", detail: "time budget" };
  try {
    const balance = asBigInt(
      await withTimeout(
        simulateRead(rpc, network, account, token, "balance", who),
        readTimeout(),
        `balance(${token.slice(0, 4)}…)`
      )
    );
    if (balance === null) return { status: "unreadable", detail: "balance() did not answer" };
    if (balance < 0n) return { status: "unreadable", detail: "balance() is negative" };
    if (balance === 0n && !describeEmpty) return { status: "empty", symbol: null, decimals: null };
    // Metadata is presentation: a token that hides or garbles its symbol is still held, and a
    // value the decoder cannot make sense of reads as none rather than failing the balance.
    if (readTimeout() <= 0) {
      return balance === 0n
        ? { status: "empty", symbol: null, decimals: null }
        : { status: "held", balance, symbol: null, decimals: null };
    }
    const decodeOr = (val: xdr.ScVal | null): unknown => {
      try {
        return val ? scValToNative(val) : null;
      } catch {
        return null;
      }
    };
    const [symbolVal, decimalsVal] = await Promise.all([
      withTimeout(
        simulateRead(rpc, network, account, token, "symbol"),
        readTimeout(),
        "symbol"
      ).catch(() => null),
      withTimeout(
        simulateRead(rpc, network, account, token, "decimals"),
        readTimeout(),
        "decimals"
      ).catch(() => null),
    ]);
    const symbol = printableSymbol(decodeOr(symbolVal));
    const decimalsNative = decodeOr(decimalsVal);
    const decimals =
      typeof decimalsNative === "number" &&
      Number.isInteger(decimalsNative) &&
      decimalsNative >= 0 &&
      decimalsNative <= 38
        ? decimalsNative
        : typeof decimalsNative === "bigint" && decimalsNative >= 0n && decimalsNative <= 38n
          ? Number(decimalsNative)
          : null;
    return balance === 0n
      ? { status: "empty", symbol, decimals }
      : { status: "held", balance, symbol, decimals };
  } catch (err) {
    return { status: "unreadable", detail: reason(err) };
  }
}

// ─── the read ────────────────────────────────────────────────────────────────

function shortContract(contract: string): string {
  return `${contract.slice(0, 4)}…${contract.slice(-4)}`;
}

/**
 * The account's Soroban token balances, best effort, with what was and was not consulted. Never
 * throws: a source that fails is reported in `coverage` and as a warning, and the ledger reads
 * that did succeed still count.
 */
export async function discoverSorobanTokens(
  address: string,
  network: Network,
  deps: SorobanTokensDeps
): Promise<SorobanTokensResult> {
  const started = deps.now();
  const deadline = started + deps.budgetMs;
  const coverage: SorobanTokenCoverage[] = [];
  const warnings: PlanBlocker[] = [];

  // Share tokens of detected positions are the positions themselves, exited by their adapters;
  // listing them here would offer the same value twice.
  const excluded = new Set<string>();
  const positionTokens = new Set<string>();
  for (const position of deps.positions) {
    // The position's own contract is a pool, market, or vault - in Soroswap and Phoenix the pair
    // contract is also its share token, and the explorer lists it as a balance.
    excluded.add(position.contractAddress);
    if ("shareToken" in position && position.shareToken) excluded.add(position.shareToken);
    if ("tokens" in position && position.tokens)
      for (const t of position.tokens) positionTokens.add(t);
    if (position.protocol === "blend" && "assetAddress" in position)
      positionTokens.add(position.assetAddress);
  }
  const candidates = new Candidates(excluded);
  for (const c of deps.manualCandidates) candidates.add(c, "manual");
  for (const c of positionTokens) candidates.add(c, "positions");
  for (const c of deps.listCandidates) candidates.add(c, "list");
  coverage.push({ source: "manual", status: deps.manualCandidates.length > 0 ? "ok" : "skipped" });
  coverage.push({ source: "positions", status: "ok" });
  coverage.push({ source: "list", status: deps.listCandidates.length > 0 ? "ok" : "skipped" });

  const explorer = deps.explorerBaseUrl
    ? explorerCandidates(address, network, deps).then(
        (found) => {
          for (const c of found) candidates.add(c, "explorer");
          coverage.push({ source: "explorer", status: "ok" });
        },
        (err: unknown) => {
          coverage.push({ source: "explorer", status: "failed", detail: reason(err) });
        }
      )
    : Promise.resolve(
        coverage.push({ source: "explorer", status: "skipped", detail: "not configured" })
      );
  // Leave room for the ledger reads: the scan may use most of the budget, not all of it.
  const events: Promise<EventScan["scanned"]> =
    deps.scanEvents === false
      ? Promise.resolve(
          coverage.push({ source: "events", status: "skipped", detail: "not requested" })
        ).then(() => null)
      : eventCandidates(address, deps, deadline - LEDGER_READS_RESERVE_MS).then(
          (scan) => {
            for (const c of scan.contracts) candidates.add(c, "events");
            coverage.push({
              source: "events",
              status: scan.scanned ? "ok" : "failed",
              ...(scan.stoppedEarly ? { detail: scan.stoppedEarly } : {}),
            });
            return scan.scanned;
          },
          (err: unknown) => {
            coverage.push({ source: "events", status: "failed", detail: reason(err) });
            return null;
          }
        );
  const [, eventsScanned] = await Promise.all([explorer, events]);

  const ordered = candidates.ordered();
  const kept = ordered.slice(0, MAX_CANDIDATES);
  if (ordered.length > kept.length) {
    warnings.push({
      code: "soroban_tokens_capped",
      message:
        `${ordered.length - kept.length} possible token contract(s) were not checked: at most ` +
        `${MAX_CANDIDATES} are read per analysis. Add any you know you hold by contract address.`,
    });
  }

  const tokens: SorobanTokenBalance[] = [];
  const unreadable: string[] = [];
  if (kept.length > 0) {
    let instances: Map<string, { isStellarAsset: boolean }>;
    try {
      instances = await withTimeout(
        readInstances(
          kept.map(([c]) => c),
          deps.rpc
        ),
        Math.max(1_000, deadline - deps.now()),
        "instance read"
      );
    } catch (err) {
      // Without the instances nothing below can be trusted; say so rather than guess.
      warnings.push({
        code: "soroban_tokens_unreadable",
        message:
          `The ${kept.length} possible Soroban token contract(s) could not be checked on the ` +
          `ledger (${reason(err)}). Retry the analysis; any balance they hold is not shown here.`,
      });
      return {
        tokens,
        unreadable: kept.map(([c]) => c),
        coverage,
        eventsScanned,
        warnings,
      };
    }
    // Absent: not a contract on this network (a candidate from a stale list). Stellar asset: its
    // balance for an account is the trustline. Neither is a Soroban token balance to decide about.
    const readable = kept.filter(([c]) => {
      const instance = instances.get(c);
      return instance !== undefined && !instance.isStellarAsset;
    });
    // A contract the user typed in that is not a Soroban token here is told back, not dropped:
    // a typo, the wrong network, or a classic asset's contract (that balance is the trustline).
    const manualIgnored = kept
      .filter(([c, sources]) => sources.includes("manual") && !readable.some(([r]) => r === c))
      .map(([c]) => {
        const instance = instances.get(c);
        return instance === undefined
          ? `${shortContract(c)} is not a contract on ${network}`
          : `${shortContract(c)} is a Stellar asset's contract; that balance is its trustline`;
      });
    if (manualIgnored.length > 0) {
      warnings.push({
        code: "soroban_tokens_manual_ignored",
        message: `Not checked as a Soroban token: ${manualIgnored.join("; ")}.`,
      });
    }
    const probes = await mapConcurrent(readable, BALANCE_CONCURRENCY, ([contract, sources]) =>
      probe(contract, address, network, deps.rpc, deps.now, deadline, sources.includes("positions"))
    );
    readable.forEach(([contract, sources], i) => {
      const result = probes[i]!;
      if (result.status === "held") {
        tokens.push({
          contract,
          balance: result.balance.toString(),
          symbol: result.symbol,
          decimals: result.decimals,
          sources,
        });
      } else if (result.status === "empty" && sources.includes("positions")) {
        // Not held yet, but a detected position's exit pays it out: listed with a zero balance so
        // the close can ask what to do with it before the exit runs, not stall afterwards.
        tokens.push({
          contract,
          balance: "0",
          symbol: result.symbol,
          decimals: result.decimals,
          sources,
        });
      } else if (result.status === "unreadable") {
        unreadable.push(contract);
      }
    });
  }

  if (unreadable.length > 0) {
    warnings.push({
      code: "soroban_tokens_unreadable",
      message:
        `${unreadable.length} token contract(s) credited this account but would not report a ` +
        `balance (${unreadable.map(shortContract).join(", ")}). They may be broken or hostile; ` +
        "anything they hold cannot be moved by this close and stays with the address.",
    });
  }
  const failed = coverage.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    warnings.push({
      code: "soroban_tokens_partial",
      message:
        `Not every source of Soroban token balances answered (${failed
          .map((c) => c.source)
          .join(", ")}), so a token this account holds may be missing here. ` +
        "Add any you know of by contract address.",
    });
  }
  tokens.sort((a, b) => a.contract.localeCompare(b.contract));
  return { tokens, unreadable: unreadable.sort(), coverage, eventsScanned, warnings };
}
