import {
  MAX_ESTIMATED_SECONDS,
  MAX_SCENARIOS,
  MAX_SESSION_XLM,
  MAX_SOROBAN_TRANSACTIONS,
  MAX_SUB_ENTRIES,
} from "./caps";
import { SCENARIOS } from "./definitions";
import { LIGHT_SELECTION } from "./presets";
import {
  demoFundingXlm,
  parseSelection,
  validateSelection,
  type ResolvedPlan,
  type ValidateOptions,
} from "./resolve";
import type { ScenarioDefinition, ScenarioSelection } from "./types";
import { formatStroops, parseStroops } from "../stroops";

// A batch is a session-level mode, never a scenario: two or three ordinary sessions created
// together and closed one after another into the same sink. The visitor picks the accounts that
// close; the server always adds one more that the close reports blocked, so the batch shows a
// partial success. Every member is a session the reaper reclaims like any other.

export const MIN_BATCH_SIZE = 2;
export const MAX_BATCH_SIZE = 3;

/** The member the server adds to every batch: a claimable balance the demo created blocks its
 *  merge until the claimant helper claims it, which the session's planned resolution does. */
export const BLOCKED_MEMBER_SELECTION: ScenarioSelection = {
  scenarios: [
    { id: "claimable-balances", params: { add_trustline: 0, time_gated: 0, demo_sponsored: 1 } },
  ],
};

const DATA_ENTRIES_SELECTION: ScenarioSelection = {
  scenarios: [{ id: "data-entries", params: { count: 3 } }],
};

/** The accounts a batch of each size closes, before the blocked one the server adds. */
export const DEFAULT_BATCH_MEMBERS: Readonly<Record<2 | 3, readonly ScenarioSelection[]>> = {
  2: [LIGHT_SELECTION],
  3: [LIGHT_SELECTION, DATA_ENTRIES_SELECTION],
};

export interface ResolvedBatch {
  /** The members in creation order: the visitor's accounts, then the blocked one. */
  members: ResolvedPlan[];
  /** Index of the member the close is expected to report blocked. */
  blockedIndex: number;
  /** What the market maker sends the members together, in XLM with seven decimals. */
  fundingXlm: string;
}

export type BatchValidationResult =
  { ok: true; batch: ResolvedBatch } | { ok: false; message: string };

const fail = (message: string): BatchValidationResult => ({ ok: false, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the accounts a batch closes from untrusted input; null for anything not shaped like
 *  them. One more than the cap is still read, so the validator can say why it refuses it. */
export function parseBatch(value: unknown): ScenarioSelection[] | null {
  if (!isRecord(value) || !Array.isArray(value.members)) return null;
  if (value.members.length > MAX_BATCH_SIZE) return null;
  const members: ScenarioSelection[] = [];
  for (const raw of value.members) {
    const selection = parseSelection(raw);
    if (!selection) return null;
    members.push(selection);
  }
  return members;
}

/**
 * Why a closable member cannot be in a batch, or null: it may use only classic scenarios (a batch
 * shares one destination, so no exchange close, and no contract calls), and its close must plan
 * no resolution (the blocked member is the server's, not the visitor's).
 */
function memberRefusal(plan: ResolvedPlan, registry: readonly ScenarioDefinition[]): string | null {
  for (const { id } of plan.selection.scenarios) {
    const def = registry.find((d) => d.id === id);
    if (def?.featureSet !== "classic") {
      return `${def?.label ?? id} cannot be part of a batch: a batch closes classic accounts only.`;
    }
  }
  if (plan.expectation.resolutions.length > 0) {
    return "an account that blocks its own close cannot be added: the batch adds one itself.";
  }
  return null;
}

function capMessage(members: readonly ResolvedPlan[]): string | null {
  const sum = (pick: (plan: ResolvedPlan) => number): number =>
    members.reduce((total, plan) => total + pick(plan), 0);
  const scenarios = sum((p) => p.selection.scenarios.length);
  if (scenarios > MAX_SCENARIOS) {
    return `This batch includes ${scenarios} scenarios across its accounts; the limit is ${MAX_SCENARIOS}.`;
  }
  const subEntries = sum((p) => p.cost.subEntries);
  if (subEntries > MAX_SUB_ENTRIES) {
    return `This batch adds ${subEntries} entries across its accounts; the limit is ${MAX_SUB_ENTRIES}.`;
  }
  const xlm = sum((p) => p.cost.xlm);
  if (xlm > MAX_SESSION_XLM) {
    return `This batch needs about ${xlm} test XLM; a batch can use at most ${MAX_SESSION_XLM}.`;
  }
  const soroban = sum((p) => p.cost.sorobanTransactions);
  if (soroban > MAX_SOROBAN_TRANSACTIONS) {
    return `This batch needs ${soroban} contract transactions; the limit is ${MAX_SOROBAN_TRANSACTIONS}.`;
  }
  const seconds = sum((p) => p.cost.seconds);
  if (seconds > MAX_ESTIMATED_SECONDS) {
    return `This batch would take about ${Math.ceil(seconds / 60)} minutes; a demo is limited to ${MAX_ESTIMATED_SECONDS / 60}.`;
  }
  return null;
}

/** The members' demo funding added up exactly, in stroops. */
function totalFundingXlm(members: readonly ResolvedPlan[]): string {
  let total = BigInt(0);
  for (const plan of members) {
    const stroops = parseStroops(demoFundingXlm(plan.cost));
    if (stroops === null) throw new Error("A member's funding is not an XLM amount");
    total += stroops;
  }
  return formatStroops(total);
}

/**
 * Checks the accounts a batch closes and adds the blocked one: two or three members in all, each a
 * selection the validator accepts on its own, and their summed cost inside the caps of one
 * session. The market maker funds each member with its own headroom on top, which comes back at
 * its merge.
 */
export function validateBatch(
  closable: readonly ScenarioSelection[],
  options: ValidateOptions = {}
): BatchValidationResult {
  const size = closable.length + 1;
  if (size > MAX_BATCH_SIZE) return fail(`A batch can close at most ${MAX_BATCH_SIZE} accounts.`);
  if (size < MIN_BATCH_SIZE) return fail(`A batch closes at least ${MIN_BATCH_SIZE} accounts.`);
  const members: ResolvedPlan[] = [];
  for (const [i, selection] of closable.entries()) {
    const result = validateSelection(selection, options);
    if (!result.ok) return fail(`Account ${i + 1}: ${result.message}`);
    const refusal = memberRefusal(result.plan, options.registry ?? SCENARIOS);
    if (refusal) return fail(`Account ${i + 1}: ${refusal}`);
    members.push(result.plan);
  }
  const blocked = validateSelection(BLOCKED_MEMBER_SELECTION, options);
  if (!blocked.ok) return fail(`The blocked account is not available here: ${blocked.message}`);
  members.push(blocked.plan);
  const capped = capMessage(members);
  if (capped) return fail(capped);
  return {
    ok: true,
    batch: { members, blockedIndex: members.length - 1, fundingXlm: totalFundingXlm(members) },
  };
}

/** Reads a `?batch=` link value: the batch size, or null for anything else. */
export function parseBatchSize(value: string | null): 2 | 3 | null {
  return value === "2" ? 2 : value === "3" ? 3 : null;
}
