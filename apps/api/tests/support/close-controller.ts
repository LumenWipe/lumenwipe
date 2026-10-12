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
import type { StatsService } from "@/stats/stats.service";

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
