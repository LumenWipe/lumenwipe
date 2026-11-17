import type { AccountState } from "@lumenwipe/sdk";

/** An account holding only its native balance, with no entries, signers or positions. */
export function accountState(address: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    address,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "0",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    defiPositions: {
      address,
      network: "testnet",
      positions: [],
      unrecognizedPositions: [],
      enrichment: {},
      source: "empty",
      timestamp: null,
      queryKeys: {
        rpcEndpoints: [],
        rpcPolicy: {
          maxKeysPerCall: 0,
          recommendedConcurrency: 0,
          backoffOn429Ms: [],
          timeoutMs: 0,
        },
        slices: {},
      },
    },
    defiPositionsWarnings: [],
    ...overrides,
  };
}
