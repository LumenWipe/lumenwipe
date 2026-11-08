import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "@/lib/utils/with-timeout";
import { USAGE_STORE, type UsageStore } from "./usage-store";

export const METERING_CLOCK = Symbol("METERING_CLOCK");
export const RECORD_TIMEOUT_MS = 1_500;
export const USAGE_WINDOW_DAYS = 30;

export interface Usage {
  today: number;
  last30Days: number;
}

export interface KeyUsage extends Usage {
  rateLimitedLast30Days: number;
}

/** One owner's counts and each of its keys', from a single read. */
export interface UsageReport {
  owner: Usage;
  byKey: Record<string, KeyUsage>;
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Per-integrator request counts, durable across restarts, bucketed by UTC day. */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    @Inject(USAGE_STORE) private readonly store: UsageStore,
    @Inject(METERING_CLOCK) private readonly now: () => Date
  ) {}

  /** Never throws: a metering outage undercounts rather than failing the integrator's request. */
  async record(owner: string, route: string, keyId: string | null = null): Promise<void> {
    const date = utcDate(this.now());
    try {
      await withTimeout(
        this.store.increment(owner, route, date, keyId),
        RECORD_TIMEOUT_MS,
        "timed out"
      );
    } catch (e) {
      this.logger.warn(
        `usage_write_failed owner=${owner} date=${date} route=${route}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /** Null when the store cannot be read, so a key listing still works without its usage line. */
  async usage(owner: string): Promise<Usage | null> {
    return (await this.report(owner))?.owner ?? null;
  }

  /** The last `USAGE_WINDOW_DAYS` UTC days, today included. Null when the store cannot be read. */
  async report(owner: string): Promise<UsageReport | null> {
    const now = this.now();
    const today = utcDate(now);
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - (USAGE_WINDOW_DAYS - 1));
    try {
      const days = await this.store.daily(owner, utcDate(from));
      const byKey: Record<string, KeyUsage> = {};
      const keyUsage = (id: string): KeyUsage =>
        (byKey[id] ??= { today: 0, last30Days: 0, rateLimitedLast30Days: 0 });
      for (const day of days) {
        for (const [id, n] of Object.entries(day.byKey ?? {})) {
          keyUsage(id).last30Days += n;
          if (day.date === today) keyUsage(id).today += n;
        }
        for (const [id, n] of Object.entries(day.rateLimitedByKey ?? {})) {
          keyUsage(id).rateLimitedLast30Days += n;
        }
      }
      return {
        owner: {
          today: days.find((d) => d.date === today)?.total ?? 0,
          last30Days: days.reduce((n, d) => n + d.total, 0),
        },
        byKey,
      };
    } catch (e) {
      this.logger.warn(`usage_read_failed owner=${owner}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
