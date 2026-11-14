import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { rpcProviders, RPC_URLS, RPC_HEADERS, type ProviderEndpoint } from "@/config/networks";
import {
  RPC_MAX_LEDGER_AGE_SECONDS,
  RPC_PROVIDER_COOLDOWN_MS,
  RPC_READ_TIMEOUT_MS,
  RPC_SIMULATE_TIMEOUT_MS,
} from "@/config/constants";
import { currentDeadline, currentProviderPins } from "@/common/request-context";
import { parseLedgerCloseTime } from "./claim-predicates";
import { recordProviderFailover } from "./provider-failover";
import { UpstreamError, type UpstreamErrorKind } from "./upstream-client";
import { recordUpstream } from "./upstream-metrics";

// Memoized per-network singletons. A switch rather than a map keyed by the caller's string, so a
// value that is not one of the two networks can never name a property.
let mainnetServer: rpc.Server | undefined;
let testnetServer: rpc.Server | undefined;

export function getRpcServer(network: Network): rpc.Server {
  switch (network) {
    case "mainnet":
      return (mainnetServer ??= withRequestDeadline("mainnet"));
    case "testnet":
      return (testnetServer ??= withRequestDeadline("testnet"));
  }
}

const SIMULATION_METHODS = new Set<PropertyKey>(["simulateTransaction", "prepareTransaction"]);

// The SDK defaults to CAP-71 v2 address credentials. Every close authorizes with the source
// account's own credentials, so the legacy format is requested explicitly to keep the built
// transactions identical to what the web verifier was written against.
function withLegacyAuth(prop: PropertyKey, args: unknown[]): unknown[] {
  if (prop === "simulateTransaction") return [args[0], args[1], args[2], args[3] ?? false];
  if (prop === "prepareTransaction") return [args[0], args[1] ?? false];
  return args;
}

// Allowlist, not denylist: a method added to the SDK later is passed through untouched until
// someone decides it is safe to race. Submission is deliberately absent: abandoning a submit
// mid-flight would leave a transaction that may still land with no one watching it.
const READ_METHODS = new Set<PropertyKey>([
  "getAccount",
  "getAccountEntry",
  "getAssetBalance",
  "getClaimableBalance",
  "getContractData",
  "getEvents",
  "getFeeStats",
  "getHealth",
  "getLatestLedger",
  "getLedgerEntries",
  "getLedgerEntry",
  "getNetwork",
  "getTransaction",
  "getTrustline",
]);

export interface RpcPin {
  endpoint: ProviderEndpoint;
  /** The ledger the probe saw; null when no probe ran. */
  ledger: number | null;
}

interface PinEntry {
  pin: Promise<RpcPin>;
  settled?: RpcPin;
}

interface ProviderServers {
  reads: rpc.Server;
  simulation: rpc.Server;
}

const providerServers = new Map<string, ProviderServers>();

function serversFor(network: Network, provider: ProviderEndpoint): ProviderServers {
  const key = `${network}\n${provider.url}\n${JSON.stringify(provider.headers)}`;
  let servers = providerServers.get(key);
  if (!servers) {
    servers = {
      reads: buildRpcServer(network, { timeout: RPC_READ_TIMEOUT_MS, provider }),
      simulation: buildRpcServer(network, { timeout: RPC_SIMULATE_TIMEOUT_MS, provider }),
    };
    providerServers.set(key, servers);
  }
  return servers;
}

function withinMs<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamError("timeout", "rpc")), ms);
    call.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function latestFreshLedger(
  network: Network,
  provider: ProviderEndpoint,
  capMs: number
): Promise<number> {
  const latest = await withinMs(serversFor(network, provider).reads.getLatestLedger(), capMs);
  const closeTime = parseLedgerCloseTime(latest.closeTime);
  if (closeTime === null || Date.now() / 1000 - closeTime > RPC_MAX_LEDGER_AGE_SECONDS) {
    throw new UpstreamError("unavailable", "rpc");
  }
  return latest.sequence;
}

// Process-local: when each provider that answered 429 or 5xx may be probed again.
const coolingUntil = new Map<string, number>();

const cooldownKey = (network: Network, provider: ProviderEndpoint): string =>
  `${network}\n${provider.url}`;

function isCooling(network: Network, provider: ProviderEndpoint): boolean {
  return (coolingUntil.get(cooldownKey(network, provider)) ?? 0) > Date.now();
}

/** Test-only: forgets every cooldown so one test's failures don't leak into another. */
export function resetRpcCooldowns(): void {
  coolingUntil.clear();
}

/** The providers to probe: the ones not cooling down first, the cooling ones only after them. */
function probeOrder(network: Network, providers: ProviderEndpoint[]): ProviderEndpoint[] {
  const ready = providers.filter((p) => !isCooling(network, p));
  if (ready.length === 0) return providers;
  const cooling = providers.filter((p) => !ready.includes(p));
  for (const skipped of cooling) {
    recordProviderFailover("rpc", network, skipped.url, ready[0]!.url, "cooling_down");
  }
  return [...ready, ...cooling];
}

/** The first provider that answers with a recent ledger, spending at most an even share of what
 *  is left of the request on each so a dead provider cannot starve a live one further down. */
async function probeProviders(network: Network, all: ProviderEndpoint[]): Promise<RpcPin> {
  const providers = probeOrder(network, all);
  const deadline = currentDeadline();
  for (const [i, endpoint] of providers.entries()) {
    const share = Math.floor((deadline?.remainingMs() ?? Infinity) / (providers.length - i));
    try {
      const capMs = Math.min(share, RPC_READ_TIMEOUT_MS);
      return { endpoint, ledger: await latestFreshLedger(network, endpoint, capMs) };
    } catch {
      const next = providers[i + 1];
      if (next) recordProviderFailover("rpc", network, endpoint.url, next.url, "probe_failed");
    }
  }
  recordUpstream(network, "rpc", "unavailable");
  throw new UpstreamError("unavailable", "rpc");
}

const pinKey = (network: Network): string => `rpc:${network}`;

/**
 * Settles the RPC provider for the current request, once: every later call stays on it, so one
 * request never reads two providers. A one-entry list probes nothing, and neither does a call
 * outside a request, which stays on the primary.
 */
export function pinRpcProvider(network: Network): Promise<RpcPin> {
  const providers = rpcProviders(network);
  const primary: RpcPin = { endpoint: providers[0]!, ledger: null };
  const pins = currentProviderPins();
  if (providers.length === 1 || !pins) return Promise.resolve(primary);

  const existing = pins.get(pinKey(network)) as PinEntry | undefined;
  if (existing) return existing.pin;
  const entry: PinEntry = { pin: probeProviders(network, providers) };
  entry.pin.then(
    (settled) => {
      entry.settled = settled;
    },
    () => undefined
  );
  pins.set(pinKey(network), entry);
  return entry.pin;
}

/** The pinned provider once its probe has settled, the primary until then. */
export function pinnedRpcProvider(network: Network): ProviderEndpoint {
  const entry = currentProviderPins()?.get(pinKey(network)) as PinEntry | undefined;
  return entry?.settled?.endpoint ?? rpcProviders(network)[0]!;
}

/** The ledger a Horizon-compatible snapshot is judged against. */
export async function rpcReferenceLedger(network: Network): Promise<number> {
  const { ledger } = await pinRpcProvider(network);
  if (ledger !== null) return ledger;
  try {
    return (await getRpcServer(network).getLatestLedger()).sequence;
  } catch {
    throw new UpstreamError("unavailable", "rpc");
  }
}

/** The provider after the pinned one, for a by-hash check; null on a one-entry list. */
export function nextRpcServer(network: Network): rpc.Server | null {
  const providers = rpcProviders(network);
  if (providers.length === 1) return null;
  const pinned = pinnedRpcProvider(network);
  const index = providers.findIndex((p) => p.url === pinned.url);
  return serversFor(network, providers[(index + 1) % providers.length]!).reads;
}

function raceDeadline<T>(call: Promise<T>): Promise<T> {
  const deadline = currentDeadline();
  if (!deadline) return call;
  return new Promise<T>((resolve, reject) => {
    const expire = (): void => reject(new UpstreamError("timeout", "rpc"));
    // Before the aborted check: a rejection nothing handles would end the process.
    call.then(resolve, reject).finally(() => deadline.signal.removeEventListener("abort", expire));
    if (deadline.signal.aborted) return expire();
    deadline.signal.addEventListener("abort", expire, { once: true });
  });
}

/** An HTTP status the provider answered with; undefined when no response came back. */
function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

// Read from the error's type and code, never its message: an SDK not-found message embeds the
// caller's address or key, which may spell "TIMEOUT".
const TIMEOUT_CODES = new Set<unknown>(["ECONNABORTED", "ETIMEDOUT"]);

function isTransportTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || TIMEOUT_CODES.has((error as { code?: unknown }).code);
}

/**
 * A 200 whose body is not a JSON-RPC envelope. The SDK's HTTP client swallows a body that fails
 * to arrive (a read timeout or a reset after the headers) and hands back no data at all.
 */
class MalformedRpcAnswer extends Error {
  constructor() {
    super("The data provider sent an incomplete answer.");
    this.name = "MalformedRpcAnswer";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonRpcRequest = (body: unknown): boolean => isRecord(body) && body.jsonrpc === "2.0";

const isJsonRpcEnvelope = (data: unknown): boolean =>
  isRecord(data) && (Object.hasOwn(data, "result") || Object.hasOwn(data, "error"));

/** Rejects a JSON-RPC answer with no envelope before the SDK parses it. */
function rejectMalformedAnswers(server: rpc.Server): rpc.Server {
  const client = server.httpClient;
  const post = client.post.bind(client) as (...args: unknown[]) => Promise<{ data: unknown }>;
  client.post = ((...args: unknown[]) =>
    post(...args).then((response) => {
      if (isJsonRpcRequest(args[1]) && !isJsonRpcEnvelope(response.data)) {
        throw new MalformedRpcAnswer();
      }
      return response;
    })) as typeof client.post;
  return server;
}

/**
 * What a failed RPC request means. Only the HTTP status, a transport timeout or an answer with no
 * JSON-RPC envelope counts: a JSON-RPC error, a missing entry or a 4xx is the provider's answer,
 * never an outage, so it maps to null.
 */
function rpcFailureKind(error: unknown): UpstreamErrorKind | null {
  if (error instanceof MalformedRpcAnswer) return "unavailable";
  const status = httpStatusOf(error);
  if (status === 429) return "rate_limited";
  if (status !== undefined) return status >= 500 ? "unavailable" : null;
  return isTransportTimeout(error) ? "timeout" : null;
}

/**
 * Types a read's outage as an `UpstreamError`, which every route answers as a 503. A provider that
 * refused (429), failed (5xx) or answered with no envelope cools down, so the next requests pin
 * another one; the current request stays on its pin. A timeout already spent its share of the
 * budget and cools nothing.
 */
function typedRead(network: Network, provider: ProviderEndpoint, call: unknown): Promise<unknown> {
  return Promise.resolve(call).catch((error: unknown) => {
    const kind = rpcFailureKind(error);
    if (kind === null) throw error;
    if (kind !== "timeout") {
      coolingUntil.set(cooldownKey(network, provider), Date.now() + RPC_PROVIDER_COOLDOWN_MS);
    }
    throw new UpstreamError(kind, "rpc");
  });
}

const isRead = (prop: PropertyKey): boolean =>
  SIMULATION_METHODS.has(prop) || READ_METHODS.has(prop);

function callPinned(network: Network, prop: PropertyKey, args: unknown[]): Promise<unknown> {
  const call = pinRpcProvider(network).then(({ endpoint }) => {
    const servers = serversFor(network, endpoint);
    const owner = SIMULATION_METHODS.has(prop) ? servers.simulation : servers.reads;
    const method = Reflect.get(owner, prop, owner) as (...args: unknown[]) => unknown;
    const result = method.apply(owner, withLegacyAuth(prop, args));
    return isRead(prop) ? typedRead(network, endpoint, result) : result;
  });
  return isRead(prop) ? raceDeadline(call) : call;
}

/**
 * The shared server: reads and simulation run on separately bounded instances, and the
 * promise-returning reads stop waiting when the current request's deadline passes. Everything
 * else, `sendTransaction` included, is the read instance's own method, called once with no
 * retry and never abandoned by the deadline. With more than one provider configured, every
 * method resolves against the request's pinned provider first, which keeps this synchronous for
 * its callers.
 */
function withRequestDeadline(network: Network): rpc.Server {
  const reads = buildRpcServer(network, { timeout: RPC_READ_TIMEOUT_MS });
  const simulation = buildRpcServer(network, { timeout: RPC_SIMULATE_TIMEOUT_MS });
  return new Proxy(reads, {
    get(target, prop) {
      const owner = SIMULATION_METHODS.has(prop) ? simulation : target;
      const value: unknown = Reflect.get(owner, prop, owner);
      if (typeof value !== "function") return value;
      if (rpcProviders(network).length > 1) {
        return (...args: unknown[]) => callPinned(network, prop, args);
      }
      const bound = (value as (...args: unknown[]) => unknown).bind(owner);
      if (!isRead(prop)) return bound;
      return (...args: unknown[]) =>
        raceDeadline(
          typedRead(network, rpcProviders(network)[0]!, bound(...withLegacyAuth(prop, args)))
        );
    },
  });
}

function recordRpcFailure(network: Network, error: unknown): void {
  const kind = rpcFailureKind(error);
  if (error instanceof MalformedRpcAnswer) recordUpstream(network, "rpc", "unavailable");
  else if (kind === "rate_limited") recordUpstream(network, "rpc", "rate_limited");
  else if (kind === "unavailable") recordUpstream(network, "rpc", "server_errors");
  else if (kind === "timeout") recordUpstream(network, "rpc", "timeouts");
  else if (httpStatusOf(error) === undefined) recordUpstream(network, "rpc", "unavailable");
}

/**
 * Counts below the SDK's methods, on its HTTP client: `pollTransaction` is many requests behind
 * one method, while a missing account or a JSON-RPC error is a successful response that a method
 * turns into a throw. A rejection here is a transport failure, an error status or a body with no
 * envelope, never an answer. The caller gets the same promise, so a send is still one call and is
 * never retried.
 */
function countRequests(network: Network, server: rpc.Server): rpc.Server {
  const client = server.httpClient;
  const post = client.post.bind(client) as (...args: unknown[]) => Promise<unknown>;
  client.post = ((...args: unknown[]) => {
    recordUpstream(network, "rpc", "requests");
    const response = post(...args);
    void response.then(undefined, (error: unknown) => recordRpcFailure(network, error));
    return response;
  }) as typeof client.post;
  return server;
}

/**
 * A fresh, non-memoized server for a call that must not share the transaction-building
 * singleton's lifetime or defaults - a health check, specifically, which wants a short
 * `timeout` (aborting the actual in-flight HTTP request, not just racing it and leaving it
 * running - the SDK wires `timeout` into a real `AbortSignal`) that `getRpcServer`'s shared
 * instance must never carry, since every other caller needs however long a real simulate/submit
 * legitimately takes.
 */
export function buildRpcServer(
  network: Network,
  opts: { timeout?: number; provider?: ProviderEndpoint } = {}
): rpc.Server {
  const { url, headers } = opts.provider ?? {
    url: RPC_URLS[network],
    headers: RPC_HEADERS[network],
  };
  return countRequests(
    network,
    rejectMalformedAnswers(
      new rpc.Server(url, {
        allowHttp: false,
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(opts.timeout !== undefined && { timeout: opts.timeout }),
      })
    )
  );
}
