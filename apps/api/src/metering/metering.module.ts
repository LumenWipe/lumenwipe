import { Module } from "@nestjs/common";
import { METERING_CLOCK, MeteringService } from "./metering.service";
import { UpstreamMetricsService } from "./upstream-metrics.service";
import { createUsageStore, USAGE_STORE } from "./usage-store";

@Module({
  providers: [
    MeteringService,
    UpstreamMetricsService,
    { provide: USAGE_STORE, useFactory: createUsageStore },
    { provide: METERING_CLOCK, useValue: () => new Date() },
  ],
  exports: [MeteringService, UpstreamMetricsService],
})
export class MeteringModule {}
