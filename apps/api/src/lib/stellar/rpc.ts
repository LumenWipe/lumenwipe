import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { RPC_URLS, RPC_HEADERS } from "@/config/networks";

// Memoized per-network singletons
const servers: Partial<Record<Network, rpc.Server>> = {};

export function getRpcServer(network: Network): rpc.Server {
  if (!servers[network]) {
    servers[network] = buildRpcServer(network);
  }
  return servers[network]!;
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
