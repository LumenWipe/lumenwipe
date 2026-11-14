import { SCENARIOS } from "./definitions";
import type { MessStepDef, MultisigVariant, SceneNodeKind, SponsorshipVariant } from "./types";

// What a plan is about to create on testnet, in the visitor's words, and where each step of it
// stands in the run. Both read only the resolved plan, the same one the executor runs.

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const NODE_LINES: readonly [SceneNodeKind, string, string][] = [
  ["trustline", "trustline", "trustlines"],
  ["offer", "open DEX offer", "open DEX offers"],
  ["data", "data entry", "data entries"],
  ["position", "protocol position", "protocol positions"],
  ["allowance", "token allowance", "token allowances"],
];

const MULTISIG_LINES: Record<MultisigVariant, string> = {
  two_of_three: "a 2-of-3 signer set",
  hash_x: "a hash(x) signer the close needs beside the master key",
  pre_auth: "a 2-of-3 signer set and a pre-authorized transaction signer",
};

const SPONSORSHIP_LINES: Record<SponsorshipVariant, string> = {
  sponsor_pays: "entries whose reserve another account pays",
  demo_sponsors: "entries the demo pays the reserve of for another account",
  unrevocable: "entries the demo sponsors for an account that cannot take them over",
};

/** The plan's footprint on testnet, one line per kind of thing, in plan order. */
export function willCreate(steps: readonly MessStepDef[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.action.kind !== "setup") continue;
    lines.push(`A demo account funded with ${Number(step.action.fundingXlm)} test XLM`);
    const issuers = step.action.ephemeralAssets.length;
    if (issuers > 0)
      lines.push(plural(issuers, "throwaway asset issuer", "throwaway asset issuers"));
  }
  const nodes = steps.flatMap((s) => s.nodes);
  for (const [kind, one, many] of NODE_LINES) {
    const count = nodes.filter((n) => n.kind === kind).length;
    if (count > 0) lines.push(plural(count, one, many));
  }
  const looseSigners = nodes.filter((n) => n.kind === "signer").length;
  if (looseSigners > 0) lines.push(plural(looseSigners, "extra signer", "extra signers"));
  for (const { action } of steps) {
    if (action.kind === "multisig") lines.push(MULTISIG_LINES[action.variant]);
    if (action.kind === "claimable_balances") {
      const n = action.balances.length;
      lines.push(plural(n, "claimable balance", "claimable balances"));
    }
    if (action.kind === "sponsored_entries") lines.push(SPONSORSHIP_LINES[action.variant]);
    if (action.kind === "open_recipient") lines.push("a recipient account for the transfers");
  }
  return lines;
}

export interface StepProgress {
  /** The step, as the plan names it. */
  label: string;
  /** Which scenario it belongs to and how far into it and the whole run it is. */
  detail: string;
}

/** Where step `index` of `steps` stands, by its scenario and in the whole run. */
export function messProgress(steps: readonly MessStepDef[], index: number): StepProgress {
  const step = steps[index];
  if (!step) return { label: "", detail: "" };
  const overall = `step ${index + 1} of ${steps.length}`;
  const scenario = step.scenario;
  if (!scenario) return { label: step.label, detail: `Setup, ${overall}` };
  const own = steps.filter((s) => s.scenario === scenario);
  const name = SCENARIOS.find((d) => d.id === scenario)?.label ?? scenario;
  return {
    label: step.label,
    detail: `${name}, ${own.indexOf(step) + 1} of ${own.length}; ${overall}`,
  };
}
