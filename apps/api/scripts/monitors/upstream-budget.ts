/**
 * Fails when an upstream has spent 70 percent of its monthly request budget, or when the counts
 * cannot be read. Read-only: it reads the `upstreamUsage` documents of this month and nothing else.
 *
 *   FIRESTORE_PROJECT_ID=<project> bun run scripts/monitors/upstream-budget.ts
 *
 * FIRESTORE_DATABASE_ID names a database other than `(default)`. Budgets are in
 * upstream-budgets.json, and their sources in docs/runbooks/provider-quotas.mdx. In a workflow it
 * writes `status` to GITHUB_OUTPUT: `finding`, `incomplete` or `clean`, as service-accounts.ts does.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createFirestore } from "@/config/firestore";
import {
  ALERT_SHARE,
  budgetUse,
  formatUse,
  monthToDate,
  overBudget,
  parseBudgets,
  type UsageDay,
} from "@/lib/monitors/upstream-budget";
import type { CheckStatus } from "@/lib/monitors/service-accounts";
import { withTimeout } from "@/lib/utils/with-timeout";

const BUDGETS = new URL("upstream-budgets.json", import.meta.url);

/** A Firestore read that hangs ends the check rather than the job's timeout. */
const READ_TIMEOUT_MS = 60_000;

export type ReadDays = (dates: string[]) => Promise<UsageDay[]>;

function firestoreReader(projectId: string): ReadDays {
  const db = createFirestore(projectId);
  return async (dates) => {
    const refs = dates.map((date) => db.collection("upstreamUsage").doc(date));
    const snaps = await db.getAll(...refs);
    return snaps.filter((s) => s.exists).map((s) => s.data() as UsageDay);
  };
}

const log = (line: string) => process.stdout.write(`${line}\n`);

export async function main(
  options: { read?: ReadDays; now?: Date; budgets?: unknown } = {}
): Promise<number> {
  let status: CheckStatus;
  try {
    const entries = parseBudgets(options.budgets ?? JSON.parse(readFileSync(BUDGETS, "utf8")));
    let read = options.read;
    if (!read) {
      const projectId = process.env.FIRESTORE_PROJECT_ID?.trim();
      if (!projectId) throw new Error("FIRESTORE_PROJECT_ID is not set");
      read = firestoreReader(projectId);
    }
    const dates = monthToDate(options.now ?? new Date());
    const days = await withTimeout(
      read(dates),
      READ_TIMEOUT_MS,
      `reading upstreamUsage took over ${READ_TIMEOUT_MS / 1000} s`
    );
    const { uses, unbudgeted } = budgetUse(entries, days);
    log(`${dates[0]} to ${dates.at(-1)}: ${days.length} day(s) with counts`);
    for (const use of uses) log(formatUse(use));
    for (const key of unbudgeted) log(`not budgeted, ignored (no longer called?): ${key}`);
    const over = uses.filter((use) => overBudget(use));
    for (const use of over) {
      process.stderr.write(
        `::error::${formatUse(use)}, at or past ${ALERT_SHARE * 100} percent: see docs/runbooks/provider-quotas.mdx\n`
      );
    }
    status = over.length > 0 ? "finding" : "clean";
  } catch (error) {
    process.stderr.write(`::error::incomplete read, not a finding: ${(error as Error).message}\n`);
    status = "incomplete";
  }
  log(`Status: ${status}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  return status === "clean" ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
