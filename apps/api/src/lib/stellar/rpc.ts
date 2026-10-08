import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { RPC_URLS, RPC_HEADERS } from "@/config/networks";

// Memoized per-network singletons. A switch rather than a map keyed by the caller's string, so a
// value that is not one of the two networks can never name a property.
let mainnetServer: rpc.Server | undefined;
let testnetServer: rpc.Server | undefined;

export function getRpcServer(network: Network): rpc.Server {
  switch (network) {
    case "mainnet":
      return (mainnetServer ??= buildRpcServer("mainnet"));
    case "testnet":
      return (testnetServer ??= buildRpcServer("testnet"));
  }
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
