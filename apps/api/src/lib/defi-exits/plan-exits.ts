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
  // xBull is a swap router (contract-registry only), never a DeFi position to exit; this label
  // exists only so this Record stays exhaustive over DefiProtocol, exactly like PROTOCOLS in
  // contract-registry/index.ts.
  xbull: "xBull",
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
  /** Targets whose exit cannot be built and that the user may choose to leave behind, in plan
   *  order, whether or not they already chose to. */
  leavable: LeavableExitTarget[];
}

/** Why one exit target cannot be exited right now. */
export interface ExitTargetBlock {
  /** The runner's or adapter's own code; the round maps it to an API error code when it refuses. */
  code: string;
  message: string;
  /** Whether the user may choose to leave this target behind (see `ExitRunResult`). */
  leaveEligible: boolean;
}

export interface ExitPreflight {
  /** Targets, by contract, whose exit could not be built when the plan checked them. */
  blocked: ReadonlyMap<string, ExitTargetBlock>;
  /** Targets, by contract, the user explicitly chose to leave behind. */
  leftBehind: ReadonlySet<string>;
}

export interface LeavableExitTarget {
  protocol: DefiProtocol;
  /** The protocol's display name, e.g. "Blend". */
  label: string;
  contract: string;
  positionCount: number;
  /** Sum of the positions' USD values as a decimal string, or null when any is unknown. */
  usdValue: string | null;
  /** Why it cannot be exited, in the plan's own words. */
  reason: string;
}

/** Non-trapping: the record of a position the user chose to leave behind. */
export const DEFI_POSITION_LEFT_BEHIND_CODE = "defi_position_left_behind";

/** Net of debt: a borrow counts against the total, and a vault (collateral and debt in one) or a
 *  net below zero has no single honest figure, so it is unknown. */
function totalUsdValue(positions: DefiPosition[]): string | null {
  let cents = 0n;
  for (const p of positions) {
    if (p.positionType === "cdp") return null;
    if (p.usdValue === null || !/^\d+(\.\d+)?$/.test(p.usdValue)) return null;
    const [whole, fraction = ""] = p.usdValue.split(".");
    const value = BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
    cents += p.positionType === "borrow" ? -value : value;
  }
  if (cents < 0n) return null;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "the Blend position in CAAA…BSC4" or "the 2 Blend positions in CAAA…BSC4". */
export function describeLeavableTarget(target: LeavableExitTarget): string {
  const n = target.positionCount;
  return (
    `the ${n === 1 ? "" : `${n} `}${target.label} position${n === 1 ? "" : "s"} ` +
    `in ${shortContract(target.contract)}`
  );
}

/** "about $12.34" or "value unknown", for the plan's wording. */
export function describeUsdValue(usdValue: string | null): string {
  return usdValue === null ? "value unknown" : `about $${usdValue}`;
}

/**
 * Plan-time view of the DeFi exits (pure: no network). One step per target the catalog can
 * exit; a blocker for every target it cannot, because a position the tool cannot close is never
 * left out of the plan in silence. Amounts and the exact request sequence are decided at build
 * time by the adapter against live state - the step's operation count is the number of
 * positions, the adapter's usual one-request-per-position shape.
 */
export function planExitSteps(
  positions: DefiPosition[],
  startIndex: number,
  preflight: ExitPreflight = { blocked: new Map(), leftBehind: new Set() }
): PlannedExits {
  const steps: PlannedStep[] = [];
  const blockers: PlanBlocker[] = [];
  const leavable: LeavableExitTarget[] = [];
  let index = startIndex;

  for (const target of groupExitTargets(positions)) {
    const label = PROTOCOL_LABEL[target.protocol];
    const where = `${label} ${shortContract(target.contract)}`;
    const exitable = exitablePositions(target);
    // Every position in the target must be one the adapter takes; a pool holding both a plain
    // supply and, say, a backstop deposit is not exitable until the adapter handles both, and the
    // half it cannot take must never fall out of the plan unmentioned.
    let block: ExitTargetBlock | undefined;
    if (exitable === null || exitable.length < target.positions.length) {
      const stuck = target.positions.length - (exitable?.length ?? 0);
      block = {
        code: "defi_exit_unsupported",
        message:
          `This account holds ${stuck} ${label} position${stuck === 1 ? "" : "s"} ` +
          `in ${shortContract(target.contract)} that LumenWipe cannot exit yet. Close ` +
          `${stuck === 1 ? "it" : "them"} through ${label} before continuing.`,
        leaveEligible: true,
      };
    } else {
      block = preflight.blocked.get(target.contract);
    }
    if (block) {
      const usdValue = totalUsdValue(target.positions);
      if (!block.leaveEligible) {
        blockers.push({ code: block.code, message: block.message });
        continue;
      }
      const leavableTarget: LeavableExitTarget = {
        protocol: target.protocol,
        label,
        contract: target.contract,
        positionCount: target.positions.length,
        usdValue,
        reason: block.message,
      };
      leavable.push(leavableTarget);
      const what = `${describeLeavableTarget(leavableTarget)} (${describeUsdValue(usdValue)})`;
      if (preflight.leftBehind.has(target.contract)) {
        blockers.push({
          code: DEFI_POSITION_LEFT_BEHIND_CODE,
          message:
            `You chose to leave ${what} behind. It stays tied to this address after the merge ` +
            "and is not withdrawn by this close.",
        });
      } else {
        blockers.push({
          code: block.code,
          message:
            `${block.message} The account cannot be merged while ${what} stays open, unless ` +
            "you choose to leave it behind.",
        });
      }
      continue;
    }
    const count = exitable!.length;
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
  return { steps, blockers, leavable };
}
