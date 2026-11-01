import { Asset, Keypair, LiquidityPoolId, xdr } from "@stellar/stellar-sdk";

export interface LedgerEntryFixture {
  key: xdr.LedgerKey;
  val: xdr.LedgerEntryData;
}

export interface AccountEntrySpec {
  sequence: string;
  numSubEntries: number;
  /** In stroops; 50 XLM when absent. */
  balance?: bigint;
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
        balance: spec.balance ?? 500_000_000n,
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

export function trustlineLedgerEntry(
  address: string,
  asset: Asset | LiquidityPoolId,
  balance: bigint,
  limit = 9223372036854775807n,
  flags = 1
): LedgerEntryFixture {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const line =
    asset instanceof LiquidityPoolId ? asset.toXDRObject() : asset.toTrustLineXDRObject();
  return {
    key: xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: line })),
    val: xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId,
        asset: line,
        balance,
        limit,
        flags,
        ext: xdr.TrustLineEntryExt.v0(),
      })
    ),
  };
}

export function offerLedgerEntry(
  address: string,
  offerId: bigint,
  selling: Asset,
  buying: Asset,
  amount: bigint
): LedgerEntryFixture {
  const sellerId = Keypair.fromPublicKey(address).xdrAccountId();
  return {
    key: xdr.LedgerKey.offer(new xdr.LedgerKeyOffer({ sellerId, offerId })),
    val: xdr.LedgerEntryData.offer(
      new xdr.OfferEntry({
        sellerId,
        offerId,
        selling: selling.toXDRObject(),
        buying: buying.toXDRObject(),
        amount,
        price: new xdr.Price({ n: 1, d: 1 }),
        flags: 0,
        ext: xdr.OfferEntryExt.v0(),
      })
    ),
  };
}

export function dataLedgerEntry(address: string, name: string, value: string): LedgerEntryFixture {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  return {
    key: xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId, dataName: name })),
    val: xdr.LedgerEntryData.data(
      new xdr.DataEntry({
        accountId,
        dataName: name,
        dataValue: Buffer.from(value, "base64"),
        ext: xdr.DataEntryExt.v0(),
      })
    ),
  };
}
