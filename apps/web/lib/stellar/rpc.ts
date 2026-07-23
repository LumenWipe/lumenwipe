import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { RPC_URLS, RPC_HEADERS } from "@/config/networks";

// Memoized per-network singletons
const servers: Partial<Record<Network, rpc.Server>> = {};

export function getRpcServer(network: Network): rpc.Server {
  if (!servers[network]) {
    const headers = RPC_HEADERS[network];
    servers[network] = new rpc.Server(RPC_URLS[network], {
      allowHttp: false,
      ...(Object.keys(headers).length > 0 && { headers }),
    });
  }
  return servers[network]!;
}
