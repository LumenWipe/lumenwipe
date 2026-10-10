import { Asset, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import type { Trustline } from "@lumenwipe/types";
import { xlmToStroops } from "@/lib/utils/amounts";

export interface LineSpec {
  balance: bigint;
  limit?: bigint;
  buying?: bigint;
  flags?: number;
}

export const AUTHORIZED = 1;
export const AUTHORIZED_TO_MAINTAIN_LIABILITIES = 2;
const MAX_LIMIT = 9223372036854775807n;

function entryFor(
  account: string,
  asset: Asset,
  spec: LineSpec
): { key: xdr.LedgerKey; val: xdr.LedgerEntryData } {
  const accountId = Keypair.fromPublicKey(account).xdrAccountId();
  const trustLineAsset = asset.toTrustLineXDRObject();
  const ext =
    spec.buying === undefined
      ? new xdr.TrustLineEntryExt(0)
      : new xdr.TrustLineEntryExt(
          1,
          new xdr.TrustLineEntryV1({
            liabilities: new xdr.Liabilities({
              buying: xdr.Int64.fromString(spec.buying.toString()),
              selling: xdr.Int64.fromString("0"),
            }),
            ext: new xdr.TrustLineEntryV1Ext(0),
          })
        );
  return {
    key: xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: trustLineAsset })),
    val: xdr.LedgerEntryData.trustline(
      new xdr.TrustLineEntry({
        accountId,
        asset: trustLineAsset,
        balance: xdr.Int64.fromString(spec.balance.toString()),
        limit: xdr.Int64.fromString((spec.limit ?? MAX_LIMIT).toString()),
        flags: spec.flags ?? AUTHORIZED,
        ext,
      })
    ),
  };
}

/**
 * A `getLedgerEntries` answering trustline keys from `lines`, keyed `account|CODE:ISSUER`; a key
 * with no line comes back as an empty result, which is how the ledger reports absence.
 */
export function ledgerEntries(
  lines: Record<string, LineSpec> | ((id: string) => LineSpec | undefined)
): (...keys: xdr.LedgerKey[]) => Promise<{ latestLedger: number; entries: unknown[] }> {
  return async (...keys) => {
    const entries: unknown[] = [];
    for (const key of keys) {
      if (key.switch().name !== "trustline") throw new Error("not stubbed");
      const tl = key.trustLine();
      const account = StrKey.encodeEd25519PublicKey(tl.accountId().ed25519());
      const asset = Asset.fromOperation(xdr.Asset.fromXDR(tl.asset().toXDR()));
      const id = `${account}|${asset.getCode()}:${asset.getIssuer()}`;
      const spec = typeof lines === "function" ? lines(id) : lines[id];
      if (spec) entries.push(entryFor(account, asset, spec));
    }
    return { latestLedger: 1000, entries };
  };
}

/**
 * A ledger that agrees with the scan-time snapshot: the source holds exactly the balances the
 * trustlines report, read lazily so a test can build its state after the stub. `extra` adds
 * lines held by other accounts, such as a transfer destination.
 */
export function mirrorSnapshot(
  source: string,
  trustlines: () => Trustline[],
  extra: Record<string, LineSpec> = {}
): ReturnType<typeof ledgerEntries> {
  return (...keys) =>
    ledgerEntries({
      ...Object.fromEntries(
        trustlines().map((tl) => [
          `${source}|${tl.asset}`,
          { balance: BigInt(xlmToStroops(tl.balance)) },
        ])
      ),
      ...extra,
    })(...keys);
}

/** Every trustline read comes back funded with nothing. */
export const emptyLines = ledgerEntries(() => ({ balance: 0n }));
