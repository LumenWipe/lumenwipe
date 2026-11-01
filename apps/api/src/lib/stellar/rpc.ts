import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { rpcProviders, RPC_URLS, RPC_HEADERS, type ProviderEndpoint } from "@/config/networks";
import {
  RPC_MAX_LEDGER_AGE_SECONDS,
  RPC_READ_TIMEOUT_MS,
  RPC_SIMULATE_TIMEOUT_MS,
} from "@/config/constants";
import { currentDeadline, currentProviderPins } from "@/common/request-context";
import { parseLedgerCloseTime } from "./claim-predicates";
import { recordProviderFailover } from "./provider-failover";
import { UpstreamError } from "./upstream-client";

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
// someone decides it is safe to race. Submission and its confirmation polling are deliberately
// absent - abandoning a submit mid-flight would leave a transaction that may still land with
// no one watching it, and polling legitimately outlives the request deadline.
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

/** The first provider that answers with a recent ledger, spending at most an even share of what
 *  is left of the request on each so a dead provider cannot starve a live one further down. */
async function probeProviders(network: Network, providers: ProviderEndpoint[]): Promise<RpcPin> {
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

function callPinned(network: Network, prop: PropertyKey, args: unknown[]): Promise<unknown> {
  const call = pinRpcProvider(network).then(({ endpoint }) => {
    const servers = serversFor(network, endpoint);
    const owner = SIMULATION_METHODS.has(prop) ? servers.simulation : servers.reads;
    const method = Reflect.get(owner, prop, owner) as (...args: unknown[]) => unknown;
    return method.apply(owner, withLegacyAuth(prop, args));
  });
  return SIMULATION_METHODS.has(prop) || READ_METHODS.has(prop) ? raceDeadline(call) : call;
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
      if (!SIMULATION_METHODS.has(prop) && !READ_METHODS.has(prop)) return bound;
      return (...args: unknown[]) =>
        raceDeadline(bound(...withLegacyAuth(prop, args)) as Promise<unknown>);
    },
  });
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
  return new rpc.Server(url, {
    allowHttp: false,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(opts.timeout !== undefined && { timeout: opts.timeout }),
  });
}
