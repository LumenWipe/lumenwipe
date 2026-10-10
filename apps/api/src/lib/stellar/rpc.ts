import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { RPC_URLS, RPC_HEADERS } from "@/config/networks";
import { RPC_READ_TIMEOUT_MS, RPC_SIMULATE_TIMEOUT_MS } from "@/config/constants";
import { currentDeadline } from "@/common/request-context";
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

function raceDeadline<T>(call: Promise<T>): Promise<T> {
  const deadline = currentDeadline();
  if (!deadline) return call;
  return new Promise<T>((resolve, reject) => {
    const expire = (): void => reject(new UpstreamError("timeout", "rpc"));
    if (deadline.signal.aborted) return expire();
    deadline.signal.addEventListener("abort", expire, { once: true });
    call.then(resolve, reject).finally(() => deadline.signal.removeEventListener("abort", expire));
  });
}

/**
 * The shared server: reads and simulation run on separately bounded instances, and the
 * promise-returning reads stop waiting when the current request's deadline passes. Everything
 * else, `sendTransaction` included, is the read instance's own method, called once with no
 * retry and never abandoned by the deadline.
 */
function withRequestDeadline(network: Network): rpc.Server {
  const reads = buildRpcServer(network, { timeout: RPC_READ_TIMEOUT_MS });
  const simulation = buildRpcServer(network, { timeout: RPC_SIMULATE_TIMEOUT_MS });
  return new Proxy(reads, {
    get(target, prop) {
      const owner = SIMULATION_METHODS.has(prop) ? simulation : target;
      const value: unknown = Reflect.get(owner, prop, owner);
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(owner);
      if (!SIMULATION_METHODS.has(prop) && !READ_METHODS.has(prop)) return bound;
      return (...args: unknown[]) => raceDeadline(bound(...args) as Promise<unknown>);
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
export function buildRpcServer(network: Network, opts: { timeout?: number } = {}): rpc.Server {
  const headers = RPC_HEADERS[network];
  return new rpc.Server(RPC_URLS[network], {
    allowHttp: false,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(opts.timeout !== undefined && { timeout: opts.timeout }),
  });
}
