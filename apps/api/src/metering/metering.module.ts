import { Module } from "@nestjs/common";
import { METERING_CLOCK, MeteringService } from "./metering.service";
import { createUsageStore, USAGE_STORE } from "./usage-store";

@Module({
  providers: [
    MeteringService,
    { provide: USAGE_STORE, useFactory: createUsageStore },
    { provide: METERING_CLOCK, useValue: () => new Date() },
  ],
  exports: [MeteringService],
})
export class MeteringModule {}
