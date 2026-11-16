import { CloseController } from "@/close/close.controller";
import { CloseService } from "@/close/close.service";
import {
  defaultClock,
  defaultCloseBuilder,
  defaultCloseReader,
  defaultExchangeRegistry,
  defaultRpcServerFactory,
  submitterFor,
} from "@/common/ports";
import { InMemoryMergeStatsStore } from "@/stats/merge-stats-store";
import { StatsService } from "@/stats/stats.service";

/** A real StatsService over an empty store whose verifier confirms nothing, so it never counts. */
export function inertStats(): StatsService {
  return new StatsService(
    new InMemoryMergeStatsStore(),
    async () => null,
    () => new Date()
  );
}

export function closeControllerWith(stats: StatsService): CloseController {
  return new CloseController(
    new CloseService(
      stats,
      defaultCloseReader,
      defaultCloseBuilder,
      submitterFor(defaultRpcServerFactory),
      defaultExchangeRegistry,
      defaultClock
    )
  );
}
