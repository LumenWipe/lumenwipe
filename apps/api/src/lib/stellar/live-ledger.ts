import { Asset, Keypair, LiquidityPoolId, SignerKey, xdr } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { LiveReadError } from "@/lib/stellar/live-trustline";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

/** The most keys one `getLedgerEntries` call accepts on Stellar RPC. */
export const RPC_LEDGER_KEY_LIMIT = 200;

export interface LiveAccountEntry {
  sequence: string;
  /** In stroops. */
  balance: bigint;
  numSubEntries: number;
  thresholds: { master: number; low: number; med: number; high: number };
  /** Every signer but the master key, whose weight is `thresholds.master`. */
  signers: Array<{ key: string; weight: number }>;
}

export interface LiveOffer {
  amount: bigint;
  selling: string;
  buying: string;
}

/**
 * The ledger's own copy of the entries an `AccountState` describes, each keyed as the state names
 * it. An entry the ledger does not hold is absent from its map.
 */
export interface LiveLedger {
  /** Null when the ledger holds no such account. */
  account: LiveAccountEntry | null;
  /** By `Trustline.asset`, and by `pool:<poolId>` for a liquidity-pool share trustline. */
  trustlines: Map<string, { balance: bigint; limit: bigint; flags: number }>;
  /** By `OpenOffer.id`. */
  offers: Map<string, LiveOffer>;
  /** By data entry name, the value in base64 as the Horizon-compatible read reports it. */
  data: Map<string, string>;
  /** The oldest ledger any of the reads reflects. */
  latestLedger?: number;
}

export function poolShareKey(poolId: string): string {
  return `pool:${poolId}`;
}

type Target =
  | { kind: "account" }
  | { kind: "trustline"; id: string }
  | { kind: "offer"; id: string }
  | { kind: "data"; id: string };

export const LIVE_LEDGER_LABEL = "The account's ledger entries";

function assetString(asset: xdr.Asset): string {
  const decoded = Asset.fromOperation(asset);
  return decoded.isNative() ? "native" : `${decoded.getCode()}:${decoded.getIssuer()}`;
}

/** Every ledger key `state` names, with what each one stands for. */
function keysFor(state: AccountState): Array<{ key: xdr.LedgerKey; target: Target }> {
  const accountId = Keypair.fromPublicKey(state.address).xdrAccountId();
  const trustline = (asset: xdr.TrustLineAsset): xdr.LedgerKey =>
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset }));
  return [
    {
      key: xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })),
      target: { kind: "account" },
    },
    ...state.trustlines.map((tl) => ({
      key: trustline(new Asset(tl.code, tl.issuer).toTrustLineXDRObject()),
      target: { kind: "trustline" as const, id: tl.asset },
    })),
    ...state.poolShares.map((share) => ({
      key: trustline(new LiquidityPoolId(share.poolId).toXDRObject()),
      target: { kind: "trustline" as const, id: poolShareKey(share.poolId) },
    })),
    ...state.openOffers.map((offer) => ({
      key: xdr.LedgerKey.offer(
        new xdr.LedgerKeyOffer({ sellerId: accountId, offerId: BigInt(offer.id) })
      ),
      target: { kind: "offer" as const, id: offer.id },
    })),
    ...state.dataEntries.map((entry) => ({
      key: xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId, dataName: entry.key })),
      target: { kind: "data" as const, id: entry.key },
    })),
  ];
}

function toLiveAccount(entry: xdr.AccountEntry): LiveAccountEntry {
  const [master, low, med, high] = entry.thresholds.value;
  return {
    sequence: entry.seqNum.toString(),
    balance: entry.balance,
    numSubEntries: entry.numSubEntries,
    thresholds: { master: master!, low: low!, med: med!, high: high! },
    signers: entry.signers.map((s) => ({
      key: SignerKey.encodeSignerKey(s.key),
      weight: s.weight,
    })),
  };
}

function record(live: LiveLedger, target: Target, val: xdr.LedgerEntryData): void {
  if (target.kind === "account" && val.type === "account") {
    live.account = toLiveAccount(val.account);
  } else if (target.kind === "trustline" && val.type === "trustline") {
    const { balance, limit, flags } = val.trustLine;
    live.trustlines.set(target.id, { balance, limit, flags });
  } else if (target.kind === "offer" && val.type === "offer") {
    live.offers.set(target.id, {
      amount: val.offer.amount,
      selling: assetString(val.offer.selling),
      buying: assetString(val.offer.buying),
    });
  } else if (target.kind === "data" && val.type === "data") {
    live.data.set(target.id, Buffer.from(val.data.dataValue.value).toString("base64"));
  } else {
    throw new LiveReadError(LIVE_LEDGER_LABEL);
  }
}

/**
 * Reads every entry `state` was enumerated from over RPC: the account, each trustline (pool
 * shares included), offer and data entry. One call per `RPC_LEDGER_KEY_LIMIT` keys. Any failed or
 * malformed read throws `LiveReadError`: an unconfirmed entry is never taken as unchanged.
 */
export async function readLiveLedger(
  server: LedgerReader,
  state: AccountState
): Promise<LiveLedger> {
  const wanted = keysFor(state);
  const byKey = new Map(wanted.map((w) => [w.key.toXDR("base64"), w.target]));
  const live: LiveLedger = {
    account: null,
    trustlines: new Map(),
    offers: new Map(),
    data: new Map(),
  };
  for (let i = 0; i < wanted.length; i += RPC_LEDGER_KEY_LIMIT) {
    const chunk = wanted.slice(i, i + RPC_LEDGER_KEY_LIMIT).map((w) => w.key);
    let response: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>;
    try {
      response = await server.getLedgerEntries(...chunk);
    } catch {
      throw new LiveReadError(LIVE_LEDGER_LABEL);
    }
    const { entries, latestLedger } = response;
    if (!Array.isArray(entries)) throw new LiveReadError(LIVE_LEDGER_LABEL);
    live.latestLedger = Math.min(live.latestLedger ?? latestLedger, latestLedger);
    for (const entry of entries) {
      const target = byKey.get(entry.key.toXDR("base64"));
      if (!target) throw new LiveReadError(LIVE_LEDGER_LABEL);
      record(live, target, entry.val);
    }
  }
  return live;
}
