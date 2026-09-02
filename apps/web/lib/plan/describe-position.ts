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

const KIND_LABELS: Record<DefiPosition["positionType"], string> = {
  supply: "Supply",
  borrow: "Borrow",
  lp: "LP position",
  stake: "Stake",
  cdp: "Vault",
};

/** A decimal string trimmed for reading: up to 7 decimals, at least 2, no trailing noise - but a
 *  nonzero amount is never rounded down to zero; a dust balance keeps every digit it has. */
export function formatPositionAmount(amount: string): string {
  const [whole = "0", frac = ""] = amount.split(".");
  let kept = frac.slice(0, 7).replace(/0+$/, "");
  if (kept === "" && /[1-9]/.test(frac)) kept = frac.replace(/0+$/, "");
  const grouped = /^\d+$/.test(whole) ? BigInt(whole).toLocaleString("en-US") : whole;
  return `${grouped}.${kept.padEnd(2, "0")}`;
}

/**
 * One line per detected position, shared by the plan preview and the completion receipt so both
 * name a position the same way.
 *
 * With display data from the analysis (pool name, symbol, underlying amount, yield) it reads the
 * way the protocol's own UI would: "Blend · Comet pool · Supply · 10.00 XLM (2.00 as collateral) ·
 * 3.99% APY". Without it, it describes what's held rather than a computed balance - Blend's
 * bToken/dToken amounts are interest-bearing share counts, not the underlying asset amount, so
 * the fallback reports what the provider returned rather than implying a conversion.
 */
export function describeDefiPosition(
  position: DefiPosition,
  enrichment: AccountState["defiPositions"]["enrichment"]
): string {
  const protocol = PROTOCOL_LABELS[position.protocol];
  const display = position.display;
  if (display) {
    const kind =
      position.positionType === "supply" && position.isBackstop
        ? "Backstop deposit"
        : KIND_LABELS[position.positionType];
    const parts = [protocol, display.pool ?? shortAddr(position.contractAddress), kind];
    if (display.amount !== null) {
      let held = formatPositionAmount(display.amount);
      if (display.asset) held += ` ${display.asset}`;
      if (display.collateralAmount !== null && display.collateralAmount !== "0") {
        held += ` (${formatPositionAmount(display.collateralAmount)} as collateral)`;
      }
      parts.push(held);
    } else if (display.asset) {
      parts.push(display.asset);
    }
    if (display.yieldPct !== null) {
      parts.push(`${display.yieldPct}% APY${display.yieldKind === "paid" ? " paid" : ""}`);
    }
    if (display.detail) parts.push(display.detail);
    return parts.join(" · ");
  }
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
