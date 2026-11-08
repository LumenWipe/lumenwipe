import { Inject, Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { API_KEY_STORE, type ApiKeyStore } from "@/auth/api-key-store";
import { withTimeout } from "@/lib/utils/with-timeout";
import { METERING_CLOCK, RECORD_TIMEOUT_MS } from "./metering.service";
import { USAGE_STORE, type RateLimitedCount, type UsageStore } from "./usage-store";

export const KEY_ACTIVITY_FLUSH_INTERVAL_MS = 60_000;

/**
 * When each self-serve key was last used and how many of its requests were refused with 429, held
 * in memory and written as batches at most once per interval while requests arrive, and once on
 * shutdown, so a busy or flooding key costs one write per minute rather than one per request.
 * Same cadence and no-timer reasoning as `UpstreamMetricsService`. A 429 never reaches the
 * interceptors, so a key that only gets 429s is written by the next served request or shutdown.
 */
@Injectable()
export class KeyActivityService implements OnApplicationShutdown {
  private readonly logger = new Logger(KeyActivityService.name);
  private lastUsed = new Map<string, Date>();
  private rateLimitedCounts = new Map<string, RateLimitedCount>();
  private lastFlushAt: number;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(API_KEY_STORE) private readonly store: ApiKeyStore,
    @Inject(USAGE_STORE) private readonly usage: UsageStore,
    @Inject(METERING_CLOCK) private readonly now: () => Date
  ) {
    this.lastFlushAt = now().getTime();
  }

  touch(keyId: string): void {
    this.lastUsed.set(keyId, this.now());
  }

  rateLimited(owner: string, keyId: string): void {
    const date = this.now().toISOString().slice(0, 10);
    const slot = `${date} ${keyId} ${owner}`;
    const entry = this.rateLimitedCounts.get(slot) ?? { owner, keyId, date, count: 0 };
    entry.count++;
    this.rateLimitedCounts.set(slot, entry);
  }

  /** Never throws. */
  async flushIfDue(): Promise<void> {
    const due = this.now().getTime() - this.lastFlushAt >= KEY_ACTIVITY_FLUSH_INTERVAL_MS;
    if (this.inFlight || !due) return;
    await this.waitForWrite(this.write());
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight) await this.waitForWrite(this.inFlight);
    await this.waitForWrite(this.write());
  }

  private write(): Promise<void> {
    this.lastFlushAt = this.now().getTime();
    const lastUsed = this.lastUsed;
    const rateLimited = this.rateLimitedCounts;
    this.lastUsed = new Map();
    this.rateLimitedCounts = new Map();
    if (lastUsed.size === 0 && rateLimited.size === 0) return Promise.resolve();

    const write = Promise.all([this.writeLastUsed(lastUsed), this.writeRateLimited(rateLimited)])
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === write) this.inFlight = null;
      });
    this.inFlight = write;
    return write;
  }

  /** Only a rejected write gives its entries back, as in `UpstreamMetricsService`. */
  private async writeLastUsed(lastUsed: Map<string, Date>): Promise<void> {
    if (lastUsed.size === 0) return;
    try {
      await this.store.recordLastUsed(lastUsed);
    } catch (e) {
      for (const [id, at] of lastUsed) if (!this.lastUsed.has(id)) this.lastUsed.set(id, at);
      this.logger.warn(`key_last_used_write_failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async writeRateLimited(counts: Map<string, RateLimitedCount>): Promise<void> {
    if (counts.size === 0) return;
    try {
      await this.usage.addRateLimited([...counts.values()]);
    } catch (e) {
      for (const [slot, entry] of counts) {
        const pending = this.rateLimitedCounts.get(slot);
        if (pending) pending.count += entry.count;
        else this.rateLimitedCounts.set(slot, entry);
      }
      this.logger.warn(
        `key_rate_limited_write_failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async waitForWrite(write: Promise<void>): Promise<void> {
    try {
      await withTimeout(write, RECORD_TIMEOUT_MS, "timed out");
    } catch {
      this.logger.warn("key_activity_write_slow: still in flight");
    }
  }
}
