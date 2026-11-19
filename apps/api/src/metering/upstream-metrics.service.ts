import { Inject, Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import rawBudgets from "@/config/upstream-budgets.json";
import {
  budgetUse,
  monthToDate,
  overBudget,
  parseBudgets,
  percentUsed,
} from "@/lib/monitors/upstream-budget";
import { drainUpstreamCounts, restoreUpstreamCounts } from "@/lib/stellar/upstream-metrics";
import { withTimeout } from "@/lib/utils/with-timeout";
import { METERING_CLOCK, RECORD_TIMEOUT_MS } from "./metering.service";
import { USAGE_STORE, type UsageStore } from "./usage-store";

export const UPSTREAM_FLUSH_INTERVAL_MS = 60_000;

/** How often one process compares the month's counts with the budgets, after a write. */
export const UPSTREAM_BUDGET_CHECK_INTERVAL_MS = 3_600_000;

/** The fixed message of the budget log line; the log-based metric in provider-quotas.mdx matches it. */
export const UPSTREAM_BUDGET_MESSAGE = "upstream request budget at 70 percent";

const BUDGETS = parseBudgets(rawBudgets);

/**
 * Moves the in-memory upstream counts to the durable store: at most one write per interval while
 * requests arrive, and one on shutdown. No timer: Cloud Run throttles CPU between requests, so
 * the write runs inside a request, and SIGTERM covers an instance scaling to zero.
 */
@Injectable()
export class UpstreamMetricsService implements OnApplicationShutdown {
  private readonly logger = new Logger(UpstreamMetricsService.name);
  private lastFlushAt: number;
  private lastBudgetCheckAt: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(USAGE_STORE) private readonly store: UsageStore,
    @Inject(METERING_CLOCK) private readonly now: () => Date
  ) {
    this.lastFlushAt = now().getTime();
  }

  /** Never throws. A slow store costs one request per interval, the one that started the write. */
  async flushIfDue(): Promise<void> {
    const due = this.now().getTime() - this.lastFlushAt >= UPSTREAM_FLUSH_INTERVAL_MS;
    if (this.inFlight || !due) return;
    await this.waitForWrite(this.write());
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight) await this.waitForWrite(this.inFlight);
    await this.waitForWrite(this.write());
  }

  /**
   * Only a rejected write gives its counts back. Hitting the cap in `waitForWrite` stops the
   * request waiting, not the write, which can still land: restoring there would count it twice.
   */
  private write(): Promise<void> {
    const at = this.now();
    this.lastFlushAt = at.getTime();
    const deltas = drainUpstreamCounts();
    if (deltas.length === 0) return Promise.resolve();

    const write = this.store
      .addUpstreamCounts(at.toISOString().slice(0, 10), deltas)
      .then(
        () => this.checkBudgetsIfDue(at),
        (e: unknown) => {
          restoreUpstreamCounts(deltas);
          this.logger.warn(
            `upstream_counts_write_failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      )
      .finally(() => {
        if (this.inFlight === write) this.inFlight = null;
      });
    this.inFlight = write;
    return write;
  }

  /**
   * Logs one line per budget at or past 70 percent this month, at most once per interval per
   * process, after a write has landed. One attempt per interval, failed or not. Never throws.
   */
  private async checkBudgetsIfDue(at: Date): Promise<void> {
    const now = at.getTime();
    if (
      this.lastBudgetCheckAt !== null &&
      now - this.lastBudgetCheckAt < UPSTREAM_BUDGET_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastBudgetCheckAt = now;
    try {
      const { uses } = budgetUse(BUDGETS, await this.store.upstreamDays(monthToDate(at)));
      for (const use of uses.filter((u) => overBudget(u))) {
        this.logger.warn({
          message: UPSTREAM_BUDGET_MESSAGE,
          provider: use.provider,
          networks: use.networks,
          upstreams: use.upstreams,
          percent: percentUsed(use),
          used: use.used,
          budget: use.budget,
        });
      }
    } catch (e) {
      this.logger.warn(
        `upstream_budget_check_failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async waitForWrite(write: Promise<void>): Promise<void> {
    try {
      await withTimeout(write, RECORD_TIMEOUT_MS, "timed out");
    } catch {
      this.logger.warn("upstream_counts_write_slow: still in flight");
    }
  }
}
