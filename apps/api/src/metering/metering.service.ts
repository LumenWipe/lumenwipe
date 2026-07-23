import { Injectable } from "@nestjs/common";

/**
 * Scaffold for per-integrator usage metering. Counts requests per API-key label
 * in memory. Durable storage and billing attribution (e.g. per completed close,
 * verified on-chain) are deferred — see the epic's deferred scope.
 */
@Injectable()
export class MeteringService {
  private readonly counts = new Map<string, number>();

  record(label: string): void {
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
