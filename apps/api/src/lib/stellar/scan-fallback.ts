import type {
  AccountSigner,
  DataEntry,
  OpenOffer,
  PoolShareEntry,
  Trustline,
} from "@lumenwipe/types";

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
