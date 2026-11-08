import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { KeyActivityService } from "./key-activity.service";
import { METERING_CLOCK, MeteringService } from "./metering.service";
import { UpstreamMetricsService } from "./upstream-metrics.service";
import { createUsageStore, USAGE_STORE } from "./usage-store";

@Module({
  imports: [AuthModule],
  providers: [
    MeteringService,
    KeyActivityService,
    UpstreamMetricsService,
    { provide: USAGE_STORE, useFactory: createUsageStore },
    { provide: METERING_CLOCK, useValue: () => new Date() },
  ],
  exports: [MeteringService, UpstreamMetricsService, KeyActivityService],
})
export class MeteringModule {}
