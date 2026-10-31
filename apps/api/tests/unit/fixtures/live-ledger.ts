import { Keypair, xdr } from "@stellar/stellar-sdk";

export interface LedgerEntryFixture {
  key: xdr.LedgerKey;
  val: xdr.LedgerEntryData;
}

export interface AccountEntrySpec {
  sequence: string;
  numSubEntries: number;
  /** master, low, med, high */
  thresholds?: [number, number, number, number];
  signers?: Array<{ key: string; weight: number }>;
}

export function accountLedgerEntry(address: string, spec: AccountEntrySpec): LedgerEntryFixture {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  return {
    key: xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })),
    val: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId,
        balance: 100_000_000n,
        seqNum: BigInt(spec.sequence),
        numSubEntries: spec.numSubEntries,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from(spec.thresholds ?? [1, 0, 0, 0]),
        signers: (spec.signers ?? []).map(
          (s) =>
            new xdr.Signer({
              key: xdr.SignerKey.signerKeyTypeEd25519(Keypair.fromPublicKey(s.key).rawPublicKey()),
              weight: s.weight,
            })
        ),
        ext: xdr.AccountEntryExt.v0(),
      })
    ),
  };
}

/**
 * A `getLedgerEntries` that answers each requested key from `entries`, leaving out keys it does
 * not hold the way the ledger reports absence, and records the size of every call.
 */
export function ledgerServer(entries: () => LedgerEntryFixture[]) {
  const calls: number[] = [];
  return {
    calls,
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys.length);
      const held = new Map(entries().map((e) => [e.key.toXDR("base64"), e]));
      const found = keys.flatMap((k) => {
        const entry = held.get(k.toXDR("base64"));
        return entry ? [entry] : [];
      });
      return { latestLedger: 1000, entries: found };
    },
  };
}
