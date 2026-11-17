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
import { NETWORK_PASSPHRASES, STELLARINDEX_API_URLS } from "@/config/networks";
import { countedFetch } from "./upstream-metrics";
import bundledLists from "@/config/soroban-token-lists.json";
import { mapConcurrent } from "@/lib/utils/concurrency";
import { describeError } from "@/lib/utils/errors";
import { getRpcServer, readLatestLedger } from "./rpc";

/**
 * Soroban (SEP-41) token balances an account holds directly - the tokens the close must decide
 * about that no classic read shows (architecture.md §10, #161).
 *
 * Soroban keeps every token balance in the token contract's own storage, keyed by holder; there
 * is no per-account index to enumerate, and the public RPC's `getEvents` has a processing cap
 * that makes scanning its seven-day retention infeasible on mainnet (a window past a few thousand
 * ledgers times out). So discovery is a union of candidate sources, and truth is the ledger:
 *
 *  - StellarIndex's account movements, the Soroban-native tokens the account has received, when
 *    a key is configured: the one per-account listing left, a third party that only proposes. It
 *    is read a few pages at most, so a busy account's oldest tokens can be missed;
 *  - the tokens named by the account's detected DeFi positions (what an exit pays out);
 *  - bundled lists of Soroban-native tokens with known liquidity (the only ones convertible);
 *  - recent on-chain `transfer` and `mint` events crediting the account, scanned in bounded
 *    windows as a freshness supplement, not as the source of record - by far the slowest
 *    source, so it is opt-in (`scanEvents`): the analysis asks for it, a close round does not;
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
  getHealth: stellarRpc.Server["getHealth"];
  getLatestLedger: stellarRpc.Server["getLatestLedger"];
}

/** How to reach StellarIndex: shared by token and allowance discovery. */
export interface IndexerClient {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

export interface SorobanTokensDeps {
  rpc: SorobanTokenRpc;
  /** StellarIndex, or null to leave it out. */
  indexer: IndexerClient | null;
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
/** Movement pages read per analysis. A busier account has more; its oldest tokens may be missed. */
export const INDEXER_MAX_PAGES = 4;
export const INDEXER_PAGE_LIMIT = 200;
/** For the whole indexer source, every page included; pages read before it runs out still count. */
export const INDEXER_TIMEOUT_MS = 4_000;
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
  options: { budgetMs?: number; scanEvents?: boolean; useIndexer?: boolean } = {}
): SorobanTokensDeps {
  return {
    rpc: getRpcServer(network),
    indexer: options.useIndexer === false ? null : defaultIndexerClient(network),
    listCandidates: bundledListCandidates(network),
    manualCandidates,
    positions,
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? SOROBAN_TOKENS_BUDGET_MS,
    // Opt-in, not opt-out: the events scan is the slowest source by far (see the module doc
    // comment above), so a caller must ask for it explicitly rather than pay for it by default.
    scanEvents: options.scanEvents ?? false,
  };
}

/** StellarIndex for this network, or null when no key is configured. */
export function defaultIndexerClient(network: Network): IndexerClient | null {
  const apiKey = process.env.STELLARINDEX_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: STELLARINDEX_API_URLS[network],
    apiKey,
    fetch: countedFetch("indexer", network, globalThis.fetch),
  };
}

/** Sources in the order their candidates are kept when the cap bites: the user's own first, the
 *  third party's last, so a flood from it cannot push out what the ledger and the lists name. */
const SOURCE_PRIORITY: SorobanTokenSource[] = ["manual", "positions", "events", "list", "indexer"];

class Candidates {
  private readonly sources = new Map<string, Set<SorobanTokenSource>>();
  constructor(private readonly excluded: Set<string>) {}
  /** Whether any source that actually looked at THIS account has proposed something: a
   *  detected position's payout token, a contract the user typed in, or the event scan. The
   *  bundled lists are excluded on purpose - they propose the same handful of contracts for every
   *  address on the network, so counting them would mean the deep sweep never runs for anyone. */
  get hasAccountSpecific(): boolean {
    for (const sources of this.sources.values()) {
      for (const source of sources) if (source !== "list") return true;
    }
    return false;
  }
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
        // `String(e)` here is what produced "[object Object]" downstream: the RPC client rejects
        // with a plain `{ code, message }`, and wrapping it this way threw its message away.
        reject(e instanceof Error ? e : new Error(describeError(e)));
      }
    );
  });
}

const reason = describeError;

// ─── candidate sources ───────────────────────────────────────────────────────

interface IndexerScan {
  contracts: string[];
  /** Set when older movements were left unread. */
  partial: string | null;
}

/** StellarIndex `/accounts/{G}/movements`, received only: every Soroban-native token in it. */
async function indexerCandidates(address: string, indexer: IndexerClient): Promise<IndexerScan> {
  const base = `${indexer.baseUrl.replace(/\/$/, "")}/accounts/${address}/movements`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
  timer.unref?.();
  const contracts = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < INDEXER_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        direction: "received",
        limit: String(INDEXER_PAGE_LIMIT),
      });
      if (cursor) params.set("cursor", cursor);
      let body: unknown;
      try {
        const res = await indexer.fetch(`${base}?${params.toString()}`, {
          signal: controller.signal,
          headers: { accept: "application/json", authorization: `Bearer ${indexer.apiKey}` },
        });
        if (res.status === 404) return { contracts: [...contracts], partial: null };
        if (!res.ok) throw new Error(`indexer responded ${res.status}`);
        body = await res.json();
      } catch (err) {
        if (page === 0) throw err;
        return {
          contracts: [...contracts],
          partial: `stopped after ${page} page(s): ${controller.signal.aborted ? "time budget" : reason(err)}`,
        };
      }
      const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
      const { movements, next_cursor } =
        data && typeof data === "object"
          ? (data as { movements?: unknown; next_cursor?: unknown })
          : {};
      if (!Array.isArray(movements)) throw new Error("indexer answered without movements");
      for (const row of movements) {
        if (!row || typeof row !== "object") continue;
        const asset = (row as { asset?: unknown }).asset;
        if (typeof asset === "string" && CONTRACT_ID.test(asset)) contracts.add(asset);
        if (contracts.size >= MAX_CANDIDATES_PER_SOURCE) {
          return { contracts: [...contracts], partial: "candidate cap" };
        }
      }
      cursor = typeof next_cursor === "string" && next_cursor !== "" ? next_cursor : null;
      if (!cursor || movements.length < INDEXER_PAGE_LIMIT) {
        return { contracts: [...contracts], partial: null };
      }
    }
    return {
      contracts: [...contracts],
      partial: `${INDEXER_MAX_PAGES} pages read; older movements were not`,
    };
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
/** How far back a scan reaches, and in what steps. Two plans are used: a shallow pass that runs
 *  on every analysis (cheap enough to hide inside the other reads), and a deep sweep that only
 *  runs when nothing else proposed a single candidate. */
interface ScanPlan {
  chunkLedgers: number;
  maxChunks: number;
}

/** What the event scan reads with: no positions, no lists. */
export type TokenEventScanDeps = Pick<SorobanTokensDeps, "rpc" | "now" | "budgetMs" | "scanEvents">;

async function eventCandidates(
  address: string,
  deps: TokenEventScanDeps,
  deadline: number,
  plan: ScanPlan = { chunkLedgers: EVENTS_CHUNK_LEDGERS, maxChunks: EVENTS_MAX_CHUNKS }
): Promise<EventScan> {
  const latest = (
    await withTimeout(
      readLatestLedger(deps.rpc),
      Math.max(1, Math.min(deadline - deps.now(), RPC_CALL_TIMEOUT_MS)),
      "latest ledger"
    )
  ).sequence;
  const filters: stellarRpc.Api.EventFilter[] = [
    { type: "contract", topics: creditTopicFilters(address) },
  ];
  const contracts = new Set<string>();
  let scanned: { fromLedger: number; toLedger: number } | null = null;
  let stoppedEarly: string | null = null;
  for (let chunk = 0; chunk < plan.maxChunks; chunk++) {
    if (contracts.size >= MAX_CANDIDATES_PER_SOURCE) break;
    // Newest windows first, so anything found in one makes the older ones unnecessary: this is a
    // best-effort sweep for tokens the indexed sources do not know, not an audit of the account's
    // whole history. Walking all six windows regardless is what made this cost ~17s.
    if (chunk > 0 && contracts.size > 0) break;
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      stoppedEarly = "time budget";
      break;
    }
    const endLedger = latest - chunk * plan.chunkLedgers;
    const startLedger = Math.max(1, endLedger - plan.chunkLedgers + 1);
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
        if (entry.key.type !== "contractData") continue;
        if (entry.val.type !== "contractData") continue;
        const instanceVal = entry.val.contractData.val;
        if (instanceVal.type !== "scvContractInstance") continue;
        const contract = Address.fromScAddress(entry.key.contractData.contract).toString();
        out.set(contract, {
          isStellarAsset: instanceVal.instance.executable.type === "contractExecutableStellarAsset",
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
  const simulation = await rpc.simulateTransaction(tx);
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

export interface TokenEventScan {
  contracts: string[];
  scanned: EventScan["scanned"];
  coverage: SorobanTokenCoverage;
}

/**
 * The recent-events source on its own, the only one that can find a token no list and no detected
 * position names. It needs neither the positions nor the lists, so the account read starts it
 * alongside DeFi detection instead of after it. Its window closes `LEDGER_READS_RESERVE_MS` before
 * the budget counted from here, leaving room for the ledger reads. Never rejects: a scan that fails
 * is a `failed` coverage entry.
 *
 * One window, not the six this used to walk. Six cost ~17s and, on an account where there is
 * nothing to find, that is paid by every analysis for no gain; one 4,000-ledger window costs
 * ~2.8s and covers the last ~5.5 hours, which is the case that actually happens: someone
 * received a token and came here to close the account. A token received before that window is
 * what the manual "add a contract address" path is for - the API already accepts it.
 */
export function startTokenEventScan(
  address: string,
  deps: TokenEventScanDeps
): Promise<TokenEventScan> {
  if (deps.scanEvents === false) {
    return Promise.resolve({
      contracts: [],
      scanned: null,
      coverage: { source: "events", status: "skipped", detail: "not requested" },
    });
  }
  const deadline = deps.now() + deps.budgetMs - LEDGER_READS_RESERVE_MS;
  return eventCandidates(address, deps, deadline, {
    chunkLedgers: EVENTS_CHUNK_LEDGERS,
    maxChunks: 1,
  }).then(
    (scan): TokenEventScan => ({
      contracts: scan.contracts,
      scanned: scan.scanned,
      coverage: {
        source: "events",
        status: scan.scanned ? "ok" : "failed",
        ...(scan.stoppedEarly ? { detail: scan.stoppedEarly } : {}),
      },
    }),
    (err: unknown): TokenEventScan => ({
      contracts: [],
      scanned: null,
      coverage: { source: "events", status: "failed", detail: reason(err) },
    })
  );
}

export interface TokenIndexerScan {
  contracts: string[];
  coverage: SorobanTokenCoverage;
}

/** The StellarIndex source on its own, started alongside the event scan for the same reason. Never
 *  rejects: a scan that fails is a `failed` coverage entry. */
export function startTokenIndexerScan(
  address: string,
  indexer: IndexerClient | null
): Promise<TokenIndexerScan> {
  if (!indexer) {
    return Promise.resolve({
      contracts: [],
      coverage: { source: "indexer", status: "skipped", detail: "not configured" },
    });
  }
  return indexerCandidates(address, indexer).then(
    (scan): TokenIndexerScan => ({
      contracts: scan.contracts,
      coverage: {
        source: "indexer",
        status: "ok",
        ...(scan.partial ? { detail: scan.partial } : {}),
      },
    }),
    (err: unknown): TokenIndexerScan => ({
      contracts: [],
      coverage: { source: "indexer", status: "failed", detail: reason(err) },
    })
  );
}

/**
 * The account's Soroban token balances, best effort, with what was and was not consulted. Never
 * throws: a source that fails is reported in `coverage` and as a warning, and the ledger reads
 * that did succeed still count.
 *
 * `eventScan` and `indexerScan` are scans the caller started earlier; without them they start here. Either way the
 * ledger reads get the whole budget counted from this call.
 */
export async function discoverSorobanTokens(
  address: string,
  network: Network,
  deps: SorobanTokensDeps,
  eventScan?: Promise<TokenEventScan>,
  indexerScan?: Promise<TokenIndexerScan>
): Promise<SorobanTokensResult> {
  const started = deps.now();
  const deadline = started + deps.budgetMs;
  const scan = eventScan ?? startTokenEventScan(address, deps);
  const coverage: SorobanTokenCoverage[] = [];
  const warnings: PlanBlocker[] = [];

  // Share tokens of detected positions are the positions themselves, exited by their adapters;
  // listing them here would offer the same value twice.
  const excluded = new Set<string>();
  const positionTokens = new Set<string>();
  for (const position of deps.positions) {
    // The position's own contract is a pool, pair, market, or vault. A Soroswap pair is also its
    // own share token. Aquarius and Phoenix keep shares in a separate contract (the pool's
    // `TokenShare` and `CONFIG.share_token`), carried on the position as `shareToken` and
    // excluded below.
    excluded.add(position.contractAddress);
    if ("shareToken" in position && position.shareToken) excluded.add(position.shareToken);
    if ("tokens" in position && position.tokens)
      for (const t of position.tokens) positionTokens.add(t);
    // A Blend reserve (paid out or repaid) and the stablecoin an FxDAO repay burns are candidates
    // too, so their balances are confirmed on the ledger without an indexer.
    if (position.protocol === "blend" && "assetAddress" in position)
      positionTokens.add(position.assetAddress);
    if (position.protocol === "fxdao" && position.debtToken) positionTokens.add(position.debtToken);
  }
  const candidates = new Candidates(excluded);
  for (const c of deps.manualCandidates) candidates.add(c, "manual");
  for (const c of positionTokens) candidates.add(c, "positions");
  for (const c of deps.listCandidates) candidates.add(c, "list");
  coverage.push({ source: "manual", status: deps.manualCandidates.length > 0 ? "ok" : "skipped" });
  coverage.push({ source: "positions", status: "ok" });
  coverage.push({ source: "list", status: deps.listCandidates.length > 0 ? "ok" : "skipped" });

  const [events, indexer] = await Promise.all([
    scan,
    indexerScan ?? startTokenIndexerScan(address, deps.indexer),
  ]);
  for (const c of events.contracts) candidates.add(c, "events");
  coverage.push(events.coverage);
  const eventsScanned = events.scanned;
  for (const c of indexer.contracts) candidates.add(c, "indexer");
  coverage.push(indexer.coverage);

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
  // The indexer only adds to what the other sources find, so its outage leaves the read as it was
  // without it rather than marking it short, which would block a close round.
  const failed = coverage.filter((c) => c.status === "failed" && c.source !== "indexer");
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
