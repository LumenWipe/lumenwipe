import type { AllowanceCoverage } from "@lumenwipe/types";

/**
 * Why an allowance list came back empty. Soroban has no index of an account's approvals, so an
 * empty result is either "every source answered and there is nothing" or "a source could not
 * answer" - and those must not look the same on screen. A page that renders the second as the
 * first makes a safety claim nobody verified, which is the one thing a security utility cannot
 * do (see the SAC filter bug in #253: the screen said "none" while the ledger said otherwise).
 */
export function unconfirmedSources(coverage: AllowanceCoverage[]): string[] {
  return coverage
    .filter((c) => c.status !== "ok")
    .map((c) => (c.source === "events" ? "the approval event scan" : "the known-contract scan"));
}

/** True only when every source completed: the one case an empty list means "none". */
export function isConfirmedEmpty(coverage: AllowanceCoverage[]): boolean {
  return unconfirmedSources(coverage).length === 0;
}
