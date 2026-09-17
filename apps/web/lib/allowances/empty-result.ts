import type { AllowanceCoverage, AllowanceSource } from "@lumenwipe/types";

/** Every source the result is expected to account for. A coverage array missing one of these
 *  says nothing about it, which is not the same as saying it found nothing. */
const EXPECTED_SOURCES: AllowanceSource[] = ["events", "registry"];

const LABELS: Record<AllowanceSource, string> = {
  events: "the approval event scan",
  registry: "the known-contract scan",
};

const label = (source: AllowanceSource): string => LABELS[source] ?? `the ${source} scan`;

/**
 * Why an allowance list came back empty. Soroban has no index of an account's approvals, so an
 * empty result is either "every source ran to completion and there is nothing" or "a source did
 * not answer for all of what it covers" - and those must not look the same on screen. A page that
 * renders the second as the first makes a safety claim nobody verified, which is the one thing a
 * security utility cannot do (see #253: the screen said "none" while the ledger said otherwise).
 *
 * The test is positive evidence, not the absence of bad news: every expected source has to be
 * present, `ok`, and carry no `detail`. A `detail` on an `ok` source is how both scans report a
 * partial pass - the event scan stopping at its candidate cap, the registry source probing only
 * part of its cross-product - and a partial pass cannot support the word "none".
 */
export function unconfirmedSources(coverage: AllowanceCoverage[] | undefined): string[] {
  const seen = coverage ?? [];
  return EXPECTED_SOURCES.filter((source) => {
    const entry = seen.find((c) => c.source === source);
    return !entry || entry.status !== "ok" || Boolean(entry.detail);
  }).map(label);
}

/** True only when every expected source completed in full: the one case an empty list means
 *  "this account has approved nobody". */
export function isConfirmedEmpty(coverage: AllowanceCoverage[] | undefined): boolean {
  return unconfirmedSources(coverage).length === 0;
}
