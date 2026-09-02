/**
 * A minimal "nothing detected, nothing to flag" `DefiPositionsResult`, for the many account-state
 * fixtures across this test suite that predate issue #150's `AccountState.defiPositions` field and
 * have no interest in DeFi behavior themselves - only `account-state.test.ts`,
 * `resolve-defi-positions.test.ts`, and `positions-gate.test.ts` construct real position payloads.
 */
import type { DefiPositionsResult, Network } from "@lumenwipe/types";

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
