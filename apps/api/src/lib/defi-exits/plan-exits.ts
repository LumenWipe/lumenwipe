import type { DefiPosition, DefiProtocol, PlanBlocker, PlannedStep } from "@lumenwipe/types";
import { SOROBAN_EXIT_FEE_ESTIMATE_STROOPS } from "@/config/constants";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { exitAdapterFor } from "./catalog";

/**
 * One exit target per (protocol, contract): the unit an adapter actually exits. Detection
 * reports a Blend pool as one position per asset and side, but they leave together, so the plan
 * shows one step per pool and the round builder runs the adapter once per pool.
 */
export interface ExitTarget {
  protocol: DefiProtocol;
  contract: string;
  positions: DefiPosition[];
}

const PROTOCOL_LABEL: Record<DefiProtocol, string> = {
  blend: "Blend",
  aquarius: "Aquarius",
  soroswap: "Soroswap",
  phoenix: "Phoenix",
  fxdao: "FxDAO",
};

function shortContract(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Deterministic: sorted by protocol, then contract, so the same positions yield the same plan. */
export function groupExitTargets(positions: DefiPosition[]): ExitTarget[] {
  const byKey = new Map<string, ExitTarget>();
  for (const position of positions) {
    const key = `${position.protocol}:${position.contractAddress}`;
    const target = byKey.get(key) ?? {
      protocol: position.protocol,
      contract: position.contractAddress,
      positions: [],
    };
    target.positions.push(position);
    byKey.set(key, target);
  }
  return [...byKey.values()].sort(
    (a, b) => a.protocol.localeCompare(b.protocol) || a.contract.localeCompare(b.contract)
  );
}

/** The positions of a target its adapter will exit, or null when there is no adapter for it. */
export function exitablePositions(target: ExitTarget): DefiPosition[] | null {
  const adapter = exitAdapterFor(target.protocol);
  if (!adapter) return null;
  return target.positions.filter((p) => adapter.supports(p));
}

export interface PlannedExits {
  steps: PlannedStep[];
  blockers: PlanBlocker[];
}

/**
 * Plan-time view of the DeFi exits (pure: no network). One step per target the catalog can
 * exit; a blocker for every target it cannot, because a position the tool cannot close is never
 * left out of the plan in silence. Amounts and the exact request sequence are decided at build
 * time by the adapter against live state - the step's operation count is the number of
 * positions, the adapter's usual one-request-per-position shape.
 */
export function planExitSteps(positions: DefiPosition[], startIndex: number): PlannedExits {
  const steps: PlannedStep[] = [];
  const blockers: PlanBlocker[] = [];
  let index = startIndex;

  for (const target of groupExitTargets(positions)) {
    const label = PROTOCOL_LABEL[target.protocol];
    const where = `${label} ${shortContract(target.contract)}`;
    const exitable = exitablePositions(target);
    // Every position in the target must be one the adapter takes; a pool holding both a plain
    // supply and, say, a backstop deposit is not exitable until the adapter handles both, and the
    // half it cannot take must never fall out of the plan unmentioned.
    if (exitable === null || exitable.length < target.positions.length) {
      const stuck = target.positions.length - (exitable?.length ?? 0);
      blockers.push({
        code: "defi_exit_unsupported",
        message:
          `This account holds ${stuck} ${label} position${stuck === 1 ? "" : "s"} ` +
          `in ${shortContract(target.contract)} that LumenWipe cannot exit yet. Close ` +
          `${stuck === 1 ? "it" : "them"} through ${label} before continuing.`,
      });
      continue;
    }
    const count = exitable.length;
    steps.push({
      index: index++,
      type: "EXIT_POSITIONS",
      title: `Exit ${where}`,
      description:
        `Leave ${where}: settle any debt first, then withdraw ${count} position${count === 1 ? "" : "s"}. ` +
        "Each step is its own transaction, simulated against live state before you sign it.",
      operationCount: count,
      estimatedFeeLumens: stroopsToXlm(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS * count),
      txXdr: null,
      status: "pending",
      txHash: null,
      error: null,
      affectedContract: target.contract,
    });
  }
  return { steps, blockers };
}
