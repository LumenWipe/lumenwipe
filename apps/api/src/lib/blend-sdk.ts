import { Version, type Network as BlendNetwork } from "@blend-capital/blend-sdk";
import type { Network } from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { pinnedRpcProvider } from "@/lib/stellar/rpc";

/** What the exit adapter and the position enricher share about the Blend SDK: how it sees one of
 *  our networks (RPC auth headers included) and how the registry's version strings map to it. */

export function blendSdkNetwork(network: Network): BlendNetwork {
  const { url, headers } = pinnedRpcProvider(network);
  return {
    rpc: url,
    passphrase: NETWORK_PASSPHRASES[network],
    ...(Object.keys(headers).length > 0 && { opts: { headers } }),
  };
}

/** Null for a version the SDK has no client for. */
export function blendSdkVersion(registryVersion: string): Version | null {
  const normalized = registryVersion.trim().toLowerCase();
  if (normalized === "v1") return Version.V1;
  if (normalized === "v2") return Version.V2;
  return null;
}
