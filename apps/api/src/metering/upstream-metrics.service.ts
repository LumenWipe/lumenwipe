import { Inject, Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { drainUpstreamCounts, restoreUpstreamCounts } from "@/lib/stellar/upstream-metrics";
import { withTimeout } from "@/lib/utils/with-timeout";
import { METERING_CLOCK, RECORD_TIMEOUT_MS } from "./metering.service";
import { USAGE_STORE, type UsageStore } from "./usage-store";

export const UPSTREAM_FLUSH_INTERVAL_MS = 60_000;

/**
 * Moves the in-memory upstream counts to the durable store: at most one write per interval while
 * requests arrive, and one on shutdown. No timer: Cloud Run throttles CPU between requests, so
 * the write runs inside a request, and SIGTERM covers an instance scaling to zero.
 */
@Injectable()
export class UpstreamMetricsService implements OnApplicationShutdown {
  private readonly logger = new Logger(UpstreamMetricsService.name);
  private lastFlushAt: number;
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
      .catch((e: unknown) => {
        restoreUpstreamCounts(deltas);
        this.logger.warn(
          `upstream_counts_write_failed: ${e instanceof Error ? e.message : String(e)}`
        );
      })
      .finally(() => {
        if (this.inFlight === write) this.inFlight = null;
      });
    this.inFlight = write;
    return write;
  }

  private async waitForWrite(write: Promise<void>): Promise<void> {
    try {
      await withTimeout(write, RECORD_TIMEOUT_MS, "timed out");
    } catch {
      this.logger.warn("upstream_counts_write_slow: still in flight");
    }
  }
}
