import type {
  AccountState,
  AccountSigner,
  DataEntry,
  OpenOffer,
  PoolShareEntry,
  Trustline,
} from "@/types/account";

// Sub-entry reconciliation: the ledger's numSubEntries is the ground truth for
// how many reserve-holding entries exist. If we enumerated fewer, the plan
// would silently leave entries behind (and the final merge would fail with
// op_has_sub_entries), so the comparison must always run - even when a data
// source is unconfigured and some entry kind cannot be enumerated at all.
export function detectSubEntryMismatch(scan: {
  address: string;
  signers: AccountSigner[];
  trustlines: Trustline[];
  openOffers: OpenOffer[];
  dataEntries: DataEntry[];
  poolShares: PoolShareEntry[];
  numSubEntries: number;
}): boolean {
  const extraSigners = scan.signers.filter((s) => s.key !== scan.address).length;
  const expectedSubEntries =
    scan.trustlines.length +
    scan.openOffers.length +
    scan.dataEntries.length +
    extraSigners +
    scan.poolShares.length * 2; // pool share trustlines cost 2 base reserves per ledger spec
  return expectedSubEntries < scan.numSubEntries;
}

// The stellar.expert account-stats endpoint cannot enumerate everything:
// it never returns manage-data entries at all (its response has no `data`
// field - see queryAccountStats in stellar-expert-explorer), and it indexes
// new accounts with a lag. Any sub-entry mismatch in the SE-based scan is
// therefore a signal to re-read the account through the zero-lag live path,
// which does enumerate data entries - the mismatch only becomes a plan
// blocker if the live scan confirms it.
export function needsLiveRescan(state: AccountState): boolean {
  return state.subEntryMismatch;
}
