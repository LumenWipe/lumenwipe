import { Address, Contract, scValToNative, xdr } from "@stellar/stellar-sdk";
import { TokenMetadata } from "@blend-capital/blend-sdk";
import type { DefiPosition, DefiPositionDisplay, Network } from "@lumenwipe/types";
import { blendSdkNetwork } from "@/lib/blend-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import type { EnrichContext, KnownToken, PositionEnricher } from "./shared";
import { formatUnits, positionKey } from "./shared";

/**
 * Display data for Soroswap LP positions, from the pair's own instance: its two tokens (keys 0
 * and 1), both reserves (keys 2 and 3), `TotalSupply`, and the LP token's SEP-41 `METADATA`
 * (name such as "ARST-XTAR Soroswap LP Token"). The account's shares come from the pair's
 * `Balance(account)`. What the shares are worth is the account's share of each reserve - the same
 * arithmetic the exit adapter uses for its floors - shown as the `detail` clause; the LP token
 * amount itself is `amount`.
 */

export interface SoroswapPairView {
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  shares: bigint;
  /** The LP token's own name, when the pair publishes one. */
  name: string | null;
}

export interface SoroswapEnrichDeps {
  readPair(network: Network, pair: string, account: string): Promise<SoroswapPairView | null>;
  tokenMetadata(network: Network, assetId: string): Promise<KnownToken>;
}

const asAddress = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvAddress()
    ? Address.fromScAddress(val.address()).toString()
    : null;

const asI128 = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  return typeof native === "bigint" ? native : null;
};

/** Reads one pair's instance and the account's share balance in a single RPC call. */
export async function readSoroswapPair(
  rpc: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">,
  pair: string,
  account: string
): Promise<SoroswapPairView | null> {
  const instanceKey = new Contract(pair).getFootprint();
  const balanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(pair).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(account).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const res = await rpc.getLedgerEntries(instanceKey, balanceKey);
  const byKey = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) byKey.set(entry.key.toXDR("base64"), entry.val);
  const instanceVal = byKey.get(instanceKey.toXDR("base64"));
  if (!instanceVal) return null;

  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instanceVal.contractData().val().instance().storage() ?? []) {
    let name: unknown;
    try {
      name = JSON.stringify(scValToNative(entry.key()));
    } catch {
      continue;
    }
    if (typeof name === "string") storage.set(name, entry.val());
  }
  const token0 = asAddress(storage.get("0"));
  const token1 = asAddress(storage.get("1"));
  const reserve0 = asI128(storage.get("2"));
  const reserve1 = asI128(storage.get("3"));
  const totalSupply = asI128(storage.get('["TotalSupply"]'));
  if (!token0 || !token1 || reserve0 === null || reserve1 === null || totalSupply === null) {
    return null;
  }
  let name: string | null = null;
  const metadata = storage.get('"METADATA"');
  if (metadata) {
    try {
      const native: unknown = scValToNative(metadata);
      if (
        native &&
        typeof native === "object" &&
        typeof (native as { name?: unknown }).name === "string"
      ) {
        name = (native as { name: string }).name;
      }
    } catch {
      name = null;
    }
  }
  const balanceVal = byKey.get(balanceKey.toXDR("base64"));
  const shares = balanceVal ? (asI128(balanceVal.contractData().val()) ?? 0n) : 0n;
  return { token0, token1, reserve0, reserve1, totalSupply, shares, name };
}

export const defaultSoroswapEnrichDeps: SoroswapEnrichDeps = {
  readPair(network, pair, account) {
    return readSoroswapPair(getRpcServer(network), pair, account);
  },
  async tokenMetadata(network, assetId) {
    const metadata = await TokenMetadata.load(blendSdkNetwork(network), assetId);
    return { symbol: metadata.symbol, decimals: metadata.decimals };
  },
};

/** "ARST-XTAR Soroswap LP Token" reads better as the pair it names. */
function pairName(name: string | null, sym0: string | null, sym1: string | null): string | null {
  if (sym0 && sym1) return `${sym0}/${sym1} pair`;
  if (!name) return null;
  return name.replace(/\s*Soroswap LP Token$/i, "").trim() || name;
}

export function soroswapPositionEnricher(
  deps: SoroswapEnrichDeps = defaultSoroswapEnrichDeps
): PositionEnricher {
  return async (positions: DefiPosition[], ctx: EnrichContext) => {
    const displays = new Map<string, DefiPositionDisplay>();
    const symbols = new Map<string, Promise<KnownToken | null>>();
    const tokenFor = (assetId: string): Promise<KnownToken | null> => {
      const known = ctx.knownTokens[assetId];
      if (known) return Promise.resolve(known);
      let pending = symbols.get(assetId);
      if (!pending) {
        pending = deps.tokenMetadata(ctx.network, assetId).catch(() => null);
        symbols.set(assetId, pending);
      }
      return pending;
    };

    await Promise.all(
      positions.map(async (position) => {
        if (position.protocol !== "soroswap" || position.positionType !== "lp") return;
        let pair: SoroswapPairView | null;
        try {
          pair = await deps.readPair(ctx.network, position.contractAddress, ctx.account);
        } catch {
          return;
        }
        if (!pair) return;
        const [t0, t1] = await Promise.all([tokenFor(pair.token0), tokenFor(pair.token1)]);
        const owed = (reserve: bigint): bigint =>
          pair.totalSupply > 0n ? (pair.shares * reserve) / pair.totalSupply : 0n;
        // A token whose decimals are unknown is shown in base units rather than under a guessed
        // scale: a wrong decimal point is worse than an unfamiliar unit.
        const side = (amount: bigint, token: KnownToken | null, address: string): string =>
          token
            ? `${formatUnits(amount, token.decimals)} ${token.symbol}`
            : `${amount} base units of ${address.slice(0, 4)}…${address.slice(-4)}`;
        displays.set(positionKey(position), {
          pool: pairName(pair.name, t0?.symbol ?? null, t1?.symbol ?? null),
          // The amount is LP tokens; what they are worth in the two reserves is the detail clause.
          asset: "shares",
          amount: formatUnits(pair.shares, 7),
          collateralAmount: null,
          yieldPct: null,
          yieldKind: null,
          detail:
            pair.totalSupply > 0n
              ? `worth ${side(owed(pair.reserve0), t0, pair.token0)} + ${side(owed(pair.reserve1), t1, pair.token1)}`
              : null,
        });
      })
    );
    return displays;
  };
}
