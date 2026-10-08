import { Module } from "@nestjs/common";
import { createMergeStatsStore, MERGE_STATS_STORE } from "./merge-stats-store";
import { StatsController } from "./stats.controller";
import { defaultMergeVerifier, MERGE_VERIFIER, STATS_CLOCK, StatsService } from "./stats.service";

@Module({
  controllers: [StatsController],
  providers: [
    StatsService,
    { provide: MERGE_STATS_STORE, useFactory: createMergeStatsStore },
    { provide: MERGE_VERIFIER, useValue: defaultMergeVerifier },
    { provide: STATS_CLOCK, useValue: () => new Date() },
  ],
  exports: [StatsService],
})
export class StatsModule {}
