import type { AccountState, DefiPosition } from "@/types/account";

export const PROTOCOL_LABELS: Record<DefiPosition["protocol"], string> = {
  blend: "Blend",
  aquarius: "Aquarius",
  soroswap: "Soroswap",
  phoenix: "Phoenix",
  fxdao: "FxDAO",
};

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

export function symbolFor(
  address: string,
  enrichment: AccountState["defiPositions"]["enrichment"]
): string {
  return enrichment[address]?.symbol ?? shortAddr(address);
}

/**
 * One line per detected position, shared by the plan preview and the completion receipt so both
 * name a position the same way. Describes what's held, not a computed user-facing balance -
 * Blend's bToken/dToken amounts are interest-bearing share counts, not the underlying asset
 * amount, so this reports what the provider returned rather than implying a conversion.
 */
export function describeDefiPosition(
  position: DefiPosition,
  enrichment: AccountState["defiPositions"]["enrichment"]
): string {
  const protocol = PROTOCOL_LABELS[position.protocol];
  switch (position.positionType) {
    case "supply":
      return `${protocol} supply · ${symbolFor(position.assetAddress, enrichment)}${
        position.isBackstop ? " (backstop)" : ""
      }`;
    case "borrow":
      return `${protocol} borrow · ${symbolFor(position.assetAddress, enrichment)}`;
    case "lp":
      return `${protocol} LP position · ${position.shareAmount} shares`;
    case "stake":
      return `${protocol} stake · ${position.stakedAmount}`;
    case "cdp":
      return `${protocol} vault · ${position.denomination} · collateral ${position.collateralAmount}, debt ${position.debtAmount}`;
  }
}

/** The contracts (pools, pairs, vaults) the positions live in, in first-seen order. */
export function positionContracts(positions: DefiPosition[]): string[] {
  return [...new Set(positions.map((p) => p.contractAddress))];
}
