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
  async record(owner: string, route: string): Promise<void> {
    const date = utcDate(this.now());
    try {
      await withTimeout(this.store.increment(owner, route, date), RECORD_TIMEOUT_MS, "timed out");
    } catch (e) {
      this.logger.warn(
        `usage_write_failed owner=${owner} date=${date} route=${route}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /** Null when the store cannot be read, so a key listing still works without its usage line. */
  async usage(owner: string): Promise<Usage | null> {
    const now = this.now();
    const today = utcDate(now);
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - (USAGE_WINDOW_DAYS - 1));
    try {
      const days = await this.store.daily(owner, utcDate(from));
      return {
        today: days.find((d) => d.date === today)?.total ?? 0,
        last30Days: days.reduce((n, d) => n + d.total, 0),
      };
    } catch (e) {
      this.logger.warn(`usage_read_failed owner=${owner}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
