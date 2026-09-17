import type { AllowanceCoverage, AllowanceSource } from "@lumenwipe/types";

/** Every source the result is expected to account for. A coverage array missing one of these
 *  says nothing about it, which is not the same as saying it found nothing. */
const EXPECTED_SOURCES: AllowanceSource[] = ["events", "registry"];

const LABELS: Record<AllowanceSource, string> = {
  events: "the approval event scan",
  registry: "the known-contract scan",
};

const label = (source: AllowanceSource): string => LABELS[source] ?? `the ${source} scan`;

const entryFor = (
  coverage: AllowanceCoverage[] | undefined,
  source: AllowanceSource
): AllowanceCoverage | undefined => (coverage ?? []).find((c) => c.source === source);

/**
 * Why an allowance list came back empty. Soroban has no index of an account's approvals, so an
 * empty result is either "the sources that can answer did answer, and there is nothing" or "a
 * source could not answer" - and those must not look the same on screen. A page that renders the
 * second as the first makes a safety claim nobody verified, which is the one thing a security
 * utility cannot do (see #253: the screen said "none" while the ledger said otherwise).
 *
 * The two sources carry different weight, and collapsing them was a mistake worth naming. The
 * event scan is what finds approvals that exist; if it failed, was skipped, or stopped short, the
 * word "none" is unsupported. The known-contract scan is a speculative cross-product - a safety
 * net for approvals whose `approve` event has aged out of RPC retention - and it is bounded by
 * design: on testnet it is 132 combinations against a 50-pair budget, so it is ALWAYS partial.
 * Treating that as "could not confirm" made the warning state the only state, which is the same
 * crying wolf as the phantom cap warning it replaced. Its partial coverage is a footnote instead.
 */
export function unconfirmedSources(coverage: AllowanceCoverage[] | undefined): string[] {
  return EXPECTED_SOURCES.filter((source) => {
    const entry = entryFor(coverage, source);
    if (!entry || entry.status !== "ok") return true;
    // Only the event scan's own partial pass is disqualifying: it drops approvals it saw and
    // stops reading older ledger windows. The registry source never claims completeness.
    return source === "events" && Boolean(entry.detail);
  }).map(label);
}

/** True when every source that can answer did: the one case an empty list means "this account
 *  has approved nobody" - within the limits the note below still states. */
export function isConfirmedEmpty(coverage: AllowanceCoverage[] | undefined): boolean {
  return unconfirmedSources(coverage).length === 0;
}

/** How far the speculative known-contract sweep got, when it did not get all the way. Shown
 *  beside a clean result so the claim stays bounded, never as an alarm. */
export function coverageNote(coverage: AllowanceCoverage[] | undefined): string | null {
  const registry = entryFor(coverage, "registry");
  if (!registry || registry.status !== "ok" || !registry.detail) return null;
  return registry.detail;
}
