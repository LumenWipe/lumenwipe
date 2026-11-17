import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./defi-positions";

/** The reviewed account as a confirm-time refresh reads it again. */
export function freshAccount(address: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    address,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "12.5000000",
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
    defiPositions: emptyDefiPositionsResult(address),
    defiPositionsWarnings: [],
    ...overrides,
  };
}
