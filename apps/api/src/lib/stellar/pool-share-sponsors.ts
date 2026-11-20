import { StrKey, xdr } from "@stellar/stellar-sdk";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { RPC_LEDGER_KEY_LIMIT, poolShareTrustlineKey } from "@/lib/stellar/live-ledger";

/**
 * The raw `getLedgerEntries` call. Only the raw answer carries `extXdr`, where the ledger keeps an
 * entry's sponsor: the SDK's parsed `getLedgerEntries` drops it, and Horizon reports no `sponsor`
 * on a pool share balance at all.
 */
export interface RawLedgerReader {
  _getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<unknown>;
}

export const POOL_SHARE_SPONSORS_LABEL = "The sponsors of the pool share trustlines";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sponsorOf(extXdr: unknown): string | null {
  if (typeof extXdr !== "string") throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
  let ext: xdr.LedgerEntryExt;
  try {
    ext = xdr.LedgerEntryExt.fromXDR(extXdr, "base64");
  } catch {
    throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
  }
  if (ext.type !== "v1") return null;
  const sponsor = ext.v1.sponsoringId;
  if (!sponsor) return null;
  return StrKey.encodeEd25519PublicKey(Buffer.from(sponsor.ed25519.value));
}

/**
 * Who sponsors each of `owner`'s pool share trustlines, by hex pool id: a G address, or null for a
 * line its owner pays for. Every line asked for must come back with its extension: a failed read,
 * a line the ledger does not hold, or a provider that does not send `extXdr` throws
 * `LiveReadError`, so an unknown sponsor is never read as "unsponsored".
 */
export async function readPoolShareSponsors(
  server: RawLedgerReader,
  owner: string,
  poolIds: string[]
): Promise<Map<string, string | null>> {
  const wanted = poolIds.map((poolId) => ({ poolId, key: poolShareTrustlineKey(owner, poolId) }));
  const poolIdByKey = new Map(wanted.map((w) => [w.key.toXDR("base64"), w.poolId]));
  const sponsors = new Map<string, string | null>();
  for (let i = 0; i < wanted.length; i += RPC_LEDGER_KEY_LIMIT) {
    const chunk = wanted.slice(i, i + RPC_LEDGER_KEY_LIMIT).map((w) => w.key);
    let response: unknown;
    try {
      response = await server._getLedgerEntries(...chunk);
    } catch {
      throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
    }
    const entries = isRecord(response) ? response.entries : undefined;
    if (!Array.isArray(entries)) throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.key !== "string") {
        throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
      }
      const poolId = poolIdByKey.get(entry.key);
      if (poolId === undefined) throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
      sponsors.set(poolId, sponsorOf(entry.extXdr));
    }
  }
  if (sponsors.size !== poolIdByKey.size) throw new LiveReadError(POOL_SHARE_SPONSORS_LABEL);
  return sponsors;
}
