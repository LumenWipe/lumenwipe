import { Inject, Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { API_KEY_STORE, type ApiKeyStore } from "@/auth/api-key-store";
import { withTimeout } from "@/lib/utils/with-timeout";
import { METERING_CLOCK, RECORD_TIMEOUT_MS } from "./metering.service";

export const KEY_ACTIVITY_FLUSH_INTERVAL_MS = 60_000;

/**
 * When each self-serve key was last used, held in memory and written as one batch at most once
 * per interval while requests arrive, and once on shutdown, so a busy key costs one write per
 * minute rather than one per request. Same cadence and no-timer reasoning as
 * `UpstreamMetricsService`.
 */
@Injectable()
export class KeyActivityService implements OnApplicationShutdown {
  private readonly logger = new Logger(KeyActivityService.name);
  private lastUsed = new Map<string, Date>();
  private lastFlushAt: number;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(API_KEY_STORE) private readonly store: ApiKeyStore,
    @Inject(METERING_CLOCK) private readonly now: () => Date
  ) {
    this.lastFlushAt = now().getTime();
  }

  touch(keyId: string): void {
    this.lastUsed.set(keyId, this.now());
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
    this.lastUsed = new Map();
    if (lastUsed.size === 0) return Promise.resolve();

    const write = this.store
      .recordLastUsed(lastUsed)
      .catch((e: unknown) => {
        for (const [id, at] of lastUsed) if (!this.lastUsed.has(id)) this.lastUsed.set(id, at);
        this.logger.warn(
          `key_activity_write_failed: ${e instanceof Error ? e.message : String(e)}`
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
      this.logger.warn("key_activity_write_slow: still in flight");
    }
  }
}
