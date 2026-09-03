import { Address, Contract, scValToNative, xdr } from "@stellar/stellar-sdk";
import { TokenMetadata } from "@blend-capital/blend-sdk";
import type { DefiPosition, DefiPositionDisplay, Network } from "@lumenwipe/types";
import { blendSdkNetwork } from "@/lib/blend-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import type { EnrichContext, KnownToken, PositionEnricher } from "./shared";
import { formatUnits, positionKey } from "./shared";

/**
 * Display data for Aquarius LP positions, from the pool's own instance: its tokens (`Tokens`, or
 * `TokenA`/`TokenB` on a constant-product pool), reserves, `TotalShares`, and share token, plus
 * the account's shares from the share token's `Balance(account)`. What the shares are worth is the
 * account's share of each reserve - the same arithmetic the exit adapter uses for its floors -
 * shown as the `detail` clause; the LP token amount itself is `amount`. Accrued rewards are not
 * shown here: reading them needs a simulated call, which is the exit adapter's job.
 */

export interface AquariusPoolView {
  tokens: string[];
  reserves: bigint[];
  totalShares: bigint;
  shares: bigint;
  poolType: string | null;
}

export interface AquariusEnrichDeps {
  readPool(network: Network, pool: string, account: string): Promise<AquariusPoolView | null>;
  tokenMetadata(network: Network, assetId: string): Promise<KnownToken>;
}

const asAddress = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvAddress()
    ? Address.fromScAddress(val.address()).toString()
    : null;

const asUnsigned = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  if (typeof native === "bigint") return native >= 0n ? native : null;
  if (typeof native === "number" && Number.isInteger(native) && native >= 0) return BigInt(native);
  return null;
};

function listOf<T>(val: xdr.ScVal | undefined, item: (v: xdr.ScVal) => T | null): T[] | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: T[] = [];
  for (const v of val.vec() ?? []) {
    const x = item(v);
    if (x === null) return null;
    out.push(x);
  }
  return out;
}

/** Reads a pool's instance and the account's share balance: two RPC calls (the share token is
 *  only known after the first). */
export async function readAquariusPool(
  rpc: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">,
  pool: string,
  account: string,
  poolType: string | null
): Promise<AquariusPoolView | null> {
  const poolKey = new Contract(pool).getFootprint();
  const first = await rpc.getLedgerEntries(poolKey);
  const poolVal = first.entries?.find(
    (e) => e.key.toXDR("base64") === poolKey.toXDR("base64")
  )?.val;
  if (!poolVal) return null;
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of poolVal.contractData().val().instance().storage() ?? []) {
    let name: unknown;
    try {
      name = JSON.stringify(scValToNative(entry.key()));
    } catch {
      continue;
    }
    if (typeof name === "string") storage.set(name, entry.val());
  }
  const tokens = storage.has('["Tokens"]')
    ? listOf(storage.get('["Tokens"]'), asAddress)
    : (() => {
        const a = asAddress(storage.get('["TokenA"]'));
        const b = asAddress(storage.get('["TokenB"]'));
        return a && b ? [a, b] : null;
      })();
  const reserves = storage.has('["Reserves"]')
    ? listOf(storage.get('["Reserves"]'), asUnsigned)
    : (() => {
        const a = asUnsigned(storage.get('["ReserveA"]'));
        const b = asUnsigned(storage.get('["ReserveB"]'));
        return a !== null && b !== null ? [a, b] : null;
      })();
  const totalShares = asUnsigned(storage.get('["TotalShares"]'));
  const shareToken = asAddress(storage.get('["TokenShare"]'));
  if (
    !tokens ||
    !reserves ||
    tokens.length !== reserves.length ||
    totalShares === null ||
    !shareToken
  ) {
    return null;
  }
  const balanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(shareToken).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(account).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const second = await rpc.getLedgerEntries(balanceKey);
  const balanceVal = second.entries?.find(
    (e) => e.key.toXDR("base64") === balanceKey.toXDR("base64")
  )?.val;
  const shares = balanceVal ? (asUnsigned(balanceVal.contractData().val()) ?? 0n) : 0n;
  return { tokens, reserves, totalShares, shares, poolType };
}

export const defaultAquariusEnrichDeps: AquariusEnrichDeps = {
  readPool(network, pool, account) {
    return readAquariusPool(getRpcServer(network), pool, account, null);
  },
  async tokenMetadata(network, assetId) {
    const metadata = await TokenMetadata.load(blendSdkNetwork(network), assetId);
    return { symbol: metadata.symbol, decimals: metadata.decimals };
  },
};

const POOL_TYPE_LABEL: Record<string, string> = {
  constant_product: "pool",
  stable: "stableswap pool",
  concentrated: "concentrated pool",
};

export function aquariusPositionEnricher(
  deps: AquariusEnrichDeps = defaultAquariusEnrichDeps
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
        if (position.protocol !== "aquarius" || position.positionType !== "lp") return;
        let pool: AquariusPoolView | null;
        try {
          pool = await deps.readPool(ctx.network, position.contractAddress, ctx.account);
        } catch {
          return;
        }
        if (!pool) return;
        const tokens = await Promise.all(pool.tokens.map(tokenFor));
        const owed = (reserve: bigint): bigint =>
          pool.totalShares > 0n ? (pool.shares * reserve) / pool.totalShares : 0n;
        // A token whose decimals are unknown is shown in base units rather than under a guessed
        // scale: a wrong decimal point is worse than an unfamiliar unit.
        const side = (i: number): string => {
          const token = tokens[i] ?? null;
          const address = pool.tokens[i]!;
          const amount = owed(pool.reserves[i]!);
          return token
            ? `${formatUnits(amount, token.decimals)} ${token.symbol}`
            : `${amount} base units of ${address.slice(0, 4)}…${address.slice(-4)}`;
        };
        const kind = POOL_TYPE_LABEL[position.poolType ?? pool.poolType ?? ""] ?? "pool";
        const named = tokens.every((t) => t !== null)
          ? `${tokens.map((t) => t!.symbol).join("/")} ${kind}`
          : null;
        displays.set(positionKey(position), {
          pool: named,
          asset: "shares",
          amount: formatUnits(pool.shares, 7),
          collateralAmount: null,
          yieldPct: null,
          yieldKind: null,
          detail:
            pool.totalShares > 0n
              ? `worth ${pool.tokens.map((_, i) => side(i)).join(" + ")}`
              : null,
        });
      })
    );
    return displays;
  };
}
