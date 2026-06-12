import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import type { Asset } from "@stellar/stellar-sdk";
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

/**
 * Reads a classic trustline entry over RPC. The SDK has no trustline
 * convenience method, so this builds the trustline LedgerKey and goes through
 * getLedgerEntries. Returns null when the trustline no longer exists.
 */
export async function getTrustlineEntry(
  server: Pick<rpc.Server, "getLedgerEntries">,
  accountAddress: string,
  asset: Asset
): Promise<xdr.TrustLineEntry | null> {
  const key = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(accountAddress).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
    })
  );
  const { entries } = await server.getLedgerEntries(key);
  if (entries.length === 0) return null;
  return entries[0].val.trustLine();
}
