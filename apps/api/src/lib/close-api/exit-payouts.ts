import { Asset } from "@stellar/stellar-sdk";
import type {
  AccountState,
  ClassicConversionQuote,
  DefiPosition,
  DefiProtocol,
  ExitPayoutEstimate,
  ExitPayoutPart,
} from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { stroopsToFixedXlm } from "@/lib/utils/amounts";
import type { ExitStep } from "@/lib/defi-exits/adapter";

/**
 * Every token contract an exit can pay into the account, per position. A pool pays out its own
 * tokens; a lending position pays out the asset it was supplied in. Read from the fields the
 * adapters themselves pass to the contract call, never from `display`, which is presentation
 * only and explicitly feeds nothing.
 *
 * Positions with no exit adapter are included anyway: they block the close rather than pay
 * anything out, so nothing arrives, and a decision asked about an asset that never shows up is
 * answered once and costs nothing. Missing the other direction is the expensive one.
 */
function payoutContracts(position: DefiPosition): string[] {
  switch (position.protocol) {
    case "blend":
      return [position.assetAddress];
    case "aquarius":
    case "soroswap":
      return [...(position.tokens ?? [])];
    default:
      // Phoenix and FxDAO carry no token addresses in their detected shape yet; when they gain
      // them, adding the case here is the whole change.
      return [];
  }
}

/**
 * The classic assets the account already trusts that a detected position's exit will pay into
 * it, by asset id ("CODE-ISSUER").
 *
 * This exists because of a dead-end the close had no other way out of. An asset arriving from an
 * exit is invisible to every other rule that decides what needs a disposition: it is not a
 * balance the account holds yet (a zero-balance trustline is skipped), and it is not a claimable
 * balance (which `claimedAmountsPerAsset` already covers). So an Aquarius LP of XLM/AQUA planned
 * cleanly, exited in round 1, paid AQUA into a trustline that had been empty - and round 2
 * refused to build anything, asking for a disposition the caller had never been shown, from a
 * screen with no way to give one.
 *
 * Matching is by Stellar Asset Contract id, which is what the pool names its tokens by, against
 * the trustlines the account holds. A SAC transfer to a G-address needs the trustline to exist,
 * so an asset that can arrive is always one already in this list.
 */
export function assetsArrivingFromExits(
  account: Pick<AccountState, "trustlines" | "network" | "defiPositions">
): Set<string> {
  const positions = account.defiPositions?.positions ?? [];
  if (positions.length === 0) return new Set();
  const payout = new Set(positions.flatMap(payoutContracts));
  if (payout.size === 0) return new Set();

  const passphrase = NETWORK_PASSPHRASES[account.network];
  const arriving = new Set<string>();
  for (const trustline of account.trustlines) {
    if (!trustline.authorized) continue;
    if (payout.has(new Asset(trustline.code, trustline.issuer).contractId(passphrase))) {
      arriving.add(trustline.asset);
    }
  }
  return arriving;
}

/**
 * What to price an arriving asset at when nothing holds it yet. Plan-time convertibility is a
 * gate - "is there a market at all" - and the authoritative quote is taken again at build time
 * against the amount that actually arrived, so probing with a nominal unit is honest here and
 * guessing the payout from a display string would not be.
 */
export const ARRIVING_ASSET_PROBE_AMOUNT = "1.0000000";

/**
 * The least an exit's planned steps pay into the account, net per asset ("native" or
 * "CODE:ISSUER"), in stroops: an LP withdrawal's floors, a lending withdrawal's live balance, less
 * each repay's full ask. Claims are left out, so the figure only leans low. Null when a step's
 * proceeds are not known from its plan (an unbond, a swap, a queued withdrawal), or when a token
 * no classic asset stands for would be spent. A token no classic asset stands for that is only
 * received is not counted: nothing converts it to XLM.
 */
export function exitPayoutOf(
  steps: readonly ExitStep[],
  account: Pick<AccountState, "trustlines" | "network">
): ExitPayoutPart[] | null {
  const passphrase = NETWORK_PASSPHRASES[account.network];
  const assetByContract = new Map<string, string>([
    [Asset.native().contractId(passphrase), "native"],
  ]);
  for (const trustline of account.trustlines) {
    if (!trustline.authorized) continue;
    try {
      assetByContract.set(
        new Asset(trustline.code, trustline.issuer).contractId(passphrase),
        trustline.asset
      );
    } catch {
      continue;
    }
  }

  const net = new Map<string, bigint>();
  const add = (contract: string, amount: string, sign: 1n | -1n): boolean => {
    if (!/^\d+$/.test(amount)) return false;
    const asset = assetByContract.get(contract);
    if (asset === undefined) return sign === 1n;
    net.set(asset, (net.get(asset) ?? 0n) + sign * BigInt(amount));
    return true;
  };

  for (const step of steps) {
    let known: boolean;
    switch (step.kind) {
      case "lp_withdraw":
        known = step.minReceived.every((m) => add(m.asset, m.amount, 1n));
        break;
      case "withdraw":
      case "withdraw_collateral":
        known = add(step.asset, step.ceiling, 1n);
        break;
      case "repay":
        known = add(step.asset, step.amount, -1n);
        break;
      case "claim":
        known = true;
        break;
      default:
        known = false;
    }
    if (!known) return null;
  }
  return [...net]
    .filter(([, stroops]) => stroops !== 0n)
    .map(([asset, stroops]) => ({ asset, stroops: stroops.toString() }));
}

export interface ExitPayoutInputs {
  account: Pick<AccountState, "trustlines" | "network">;
  /** The exit targets the close would run, in plan order. */
  targets: readonly { protocol: DefiProtocol; contract: string }[];
  /** The steps of every target the preflight could plan; a target missing here is not computed. */
  plannedSteps: ReadonlyMap<string, readonly ExitStep[]>;
  /** What each classic asset will hold before any exit, in stroops: the amount it was priced at. */
  heldStroops: ReadonlyMap<string, bigint>;
  /** Whether the asset has a route to XLM at all. */
  convertible: (asset: string) => boolean;
  /** A fresh quote for selling `amount` (fixed seven decimals) of `asset`, or null without one. */
  quote: (asset: string, amount: string) => Promise<ClassicConversionQuote | null>;
}

const NOTHING_TO_SELL: ClassicConversionQuote = { estimatedReceive: "0", minAmountOut: "0" };

/**
 * The exit payouts the plan reports for its estimate: each target's net parts, and for each
 * convertible classic asset an exit changes, a quote for the amount it will hold once every exit
 * has run. Those quotes are display data and never become a convert answer's floor: the plan's
 * own quote, for the amount held before the exits, stays the one an answer carries.
 */
export async function estimateExitPayouts(input: ExitPayoutInputs): Promise<ExitPayoutEstimate> {
  const targets = input.targets.map(({ protocol, contract }) => {
    const steps = input.plannedSteps.get(contract);
    return { protocol, contract, parts: steps ? exitPayoutOf(steps, input.account) : null };
  });

  const netByAsset = new Map<string, bigint>();
  for (const { parts } of targets) {
    for (const { asset, stroops } of parts ?? []) {
      if (asset === "native") continue;
      netByAsset.set(asset, (netByAsset.get(asset) ?? 0n) + BigInt(stroops));
    }
  }

  const quotes: Record<string, ClassicConversionQuote> = {};
  await Promise.all(
    [...netByAsset]
      .filter(([asset, net]) => net !== 0n && input.convertible(asset))
      .map(async ([asset, net]) => {
        const total = (input.heldStroops.get(asset) ?? 0n) + net;
        if (total <= 0n) {
          quotes[asset] = NOTHING_TO_SELL;
          return;
        }
        const quote = await input.quote(asset, stroopsToFixedXlm(total));
        if (quote) quotes[asset] = quote;
      })
  );
  return { targets, quotes };
}
