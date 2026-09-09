/**
 * A minimal "nothing detected, nothing to flag" `DefiPositionsResult`, for the account-state
 * fixtures across this test suite that predate issue #150's `AccountState.defiPositions` field
 * and have no interest in DeFi rendering themselves.
 */
import type { DefiPositionsResult } from "@lumenwipe/types";
import type { Network } from "@/config/networks";

export function emptyDefiPositionsResult(
  address: string,
  network: Network = "testnet"
): DefiPositionsResult {
  return {
    address,
    network,
    positions: [],
    unrecognizedPositions: [],
    enrichment: {},
    source: "empty",
    timestamp: new Date().toISOString(),
    queryKeys: {
      rpcEndpoints: [],
      rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
      slices: {},
    },
  };
}
