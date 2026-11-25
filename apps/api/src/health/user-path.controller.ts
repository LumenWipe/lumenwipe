import { Controller, Get, Logger, Res } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { analyzeAccount } from "@/account/analyze-account";
import { Public } from "@/auth/public.decorator";
import { CloseService } from "@/close/close.service";
import { DESTINATION_ACK_CHOICE, destinationDecisionId } from "@/lib/close-api/decisions";
import { UpstreamMetricsService } from "@/metering/upstream-metrics.service";
import {
  USER_PATH_FIXTURE,
  USER_PATH_NETWORK,
  UserPathProbe,
  type UserPathStepRuns,
  type UserPathVerdict,
} from "./user-path-probe";

const VERDICT_BODY =
  "`status`, `network`, `checkedAt` and one entry per step in `steps`: `step` (`analyze`, " +
  "`plan`), `result` (`ok`, `failed`), `errorClass` (`upstream`, `timeout`, `internal`, " +
  "`fixture_missing`, or null) and `latencyMs`. The body holds these fixed values only.";

export function liveUserPathSteps(close: CloseService): UserPathStepRuns {
  const logger = new Logger("user-path");
  const { source, destination } = USER_PATH_FIXTURE;
  return {
    analyze: () => analyzeAccount(source, USER_PATH_NETWORK, [], logger),
    plan: () =>
      close.plan(USER_PATH_NETWORK, {
        source,
        destination,
        decisions: [{ id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE }],
      }),
  };
}

// Its own controller so /health stays dependency-free: the liveness handler is built without
// the close services this one needs. Never point a startup or liveness probe here.
@ApiTags("health")
@Controller("health")
export class UserPathController {
  private readonly probe: UserPathProbe;

  constructor(close: CloseService, metrics: UpstreamMetricsService) {
    // The upstream flush skips /health*, so a run writes its own counts before it answers.
    this.probe = new UserPathProbe(liveUserPathSteps(close), { afterRun: () => metrics.flush() });
  }

  @Public()
  @Get("user-path")
  @ApiOperation({
    summary:
      "User path check (public, no API key): a read-only analyze and plan of one fixed public " +
      "mainnet account.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Both steps succeeded (`status` is `ok`), or the fixture account no longer exists " +
      "(`fixture_missing`), which is not a failure of the service. " +
      VERDICT_BODY +
      " The verdict is cached for 300 seconds, or 60 seconds after a failure, and callers that " +
      "arrive during a run share it, so polling never starts more than one run per period. " +
      "Nothing is signed or submitted, and the route takes no input.",
  })
  @ApiResponse({
    status: 503,
    description:
      "At least one step failed (`status` is `failed`). `errorClass` tells a provider fault " +
      "(`upstream`, `timeout`) from one of the service itself (`internal`). " +
      VERDICT_BODY,
  })
  async userPath(@Res({ passthrough: true }) res: Response): Promise<UserPathVerdict> {
    const verdict = await this.probe.verdict();
    if (verdict.status === "failed") res.status(503);
    return verdict;
  }
}
