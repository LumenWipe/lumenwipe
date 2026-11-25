/**
 * The verdict behind `GET /health/user-path`: an analyze and a plan of one fixed public account,
 * run through the code the keyed routes run.
 *
 * The route is public, so a verdict holds only the fixed unions below, and a run starts only when
 * the cached verdict has expired: callers that arrive meanwhile share the run in flight.
 */

import { HttpException, Logger } from "@nestjs/common";
import { currentUpstreamCalls, runInOwnContext } from "@/common/request-context";
import { mapDomainError, PLAN_ERRORS } from "@/lib/close-api/domain-errors";

/** Mainnet is where accounts are closed, and the only network with every upstream in play. */
export const USER_PATH_NETWORK = "mainnet";

/** The latency lab's mainnet baseline and its destination: public, read only, never signed for. */
export const USER_PATH_FIXTURE = {
  source: "GCCD6AJOYZCUAQLX32ZJF2MKFFAUJ53PVCFQI3RHWKL3V47QYE2BNAUT",
  destination: "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK",
} as const;

export const USER_PATH_STEP_BUDGET_MS = 20_000;
export const USER_PATH_OK_TTL_MS = 300_000;
/** Shorter, so a recovery or a one-off failure shows within a minute. */
export const USER_PATH_FAILED_TTL_MS = 60_000;

/** The fixed message a log-based alert matches (monitoring-plan.md). */
export const USER_PATH_FIXTURE_MISSING_MESSAGE = "user-path probe fixture account not found";

export const USER_PATH_STEPS = ["analyze", "plan"] as const;
export type UserPathStepName = (typeof USER_PATH_STEPS)[number];
export type UserPathErrorClass = "upstream" | "timeout" | "internal" | "fixture_missing";

export interface UserPathStep {
  step: UserPathStepName;
  result: "ok" | "failed";
  errorClass: UserPathErrorClass | null;
  latencyMs: number;
}

export interface UserPathVerdict {
  status: "ok" | "failed" | "fixture_missing";
  network: typeof USER_PATH_NETWORK;
  checkedAt: string;
  steps: UserPathStep[];
}

export type UserPathStepRuns = Record<UserPathStepName, () => Promise<unknown>>;

export interface UserPathProbeOptions {
  now?: () => number;
  stepBudgetMs?: number;
  /** Awaited inside the run, before its verdict is served. */
  afterRun?: () => Promise<void>;
}

/** The statuses the keyed routes answer when the fault is a provider's, or the read raced it. */
const UPSTREAM_STATUSES = new Set([409, 502, 503, 504]);

const TIMED_OUT = Symbol("timed out");

/** Classed by the status the keyed route would have answered, never by the error's text. */
function errorClassOf(error: unknown): UserPathErrorClass {
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : (mapDomainError(PLAN_ERRORS, error)?.status ?? 500);
  if (status === 404) return "fixture_missing";
  return UPSTREAM_STATUSES.has(status) ? "upstream" : "internal";
}

function statusOf(steps: readonly UserPathStep[]): UserPathVerdict["status"] {
  const classes = steps.map((s) => s.errorClass);
  if (classes.some((c) => c !== null && c !== "fixture_missing")) return "failed";
  return classes.includes("fixture_missing") ? "fixture_missing" : "ok";
}

export class UserPathProbe {
  private readonly logger = new Logger("user-path");
  private readonly now: () => number;
  private readonly stepBudgetMs: number;
  private readonly afterRun: () => Promise<void>;
  private cached: { verdict: UserPathVerdict; expiresAt: number } | null = null;
  private running: Promise<UserPathVerdict> | null = null;

  constructor(
    private readonly steps: UserPathStepRuns,
    options: UserPathProbeOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.stepBudgetMs = options.stepBudgetMs ?? USER_PATH_STEP_BUDGET_MS;
    this.afterRun = options.afterRun ?? (() => Promise.resolve());
  }

  verdict(): Promise<UserPathVerdict> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.verdict);
    }
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<UserPathVerdict> {
    const runs = await Promise.all(USER_PATH_STEPS.map((step) => this.runStep(step)));
    const steps = runs.map((r) => r.step);
    const finishedAt = this.now();
    const verdict: UserPathVerdict = {
      status: statusOf(steps),
      network: USER_PATH_NETWORK,
      checkedAt: new Date(finishedAt).toISOString(),
      steps,
    };
    this.logger[verdict.status === "failed" ? "warn" : "log"]({
      message: "user-path probe run",
      status: verdict.status,
      steps: runs.map((r) => ({ ...r.step, upstreamCalls: Object.fromEntries(r.upstreamCalls) })),
    });
    if (verdict.status === "fixture_missing") {
      this.logger.error({ message: USER_PATH_FIXTURE_MISSING_MESSAGE, network: USER_PATH_NETWORK });
    }
    await this.afterRun().catch(() => undefined);
    const ttlMs = verdict.status === "failed" ? USER_PATH_FAILED_TTL_MS : USER_PATH_OK_TTL_MS;
    this.cached = { verdict, expiresAt: finishedAt + ttlMs };
    return verdict;
  }

  /**
   * One step as a request of its own, stopped at the budget. The context's deadline expires with
   * it: Horizon requests in flight are aborted and every RPC read is rejected, so the step issues
   * nothing further. An RPC request already sent still ends on its own HTTP timeout
   * (RPC_READ_TIMEOUT_MS, RPC_SIMULATE_TIMEOUT_MS); its answer is discarded.
   */
  private async runStep(
    name: UserPathStepName
  ): Promise<{ step: UserPathStep; upstreamCalls: Map<string, number> }> {
    const startedAt = this.now();
    let upstreamCalls = new Map<string, number>();
    const attempt = runInOwnContext(this.stepBudgetMs, async () => {
      upstreamCalls = currentUpstreamCalls() ?? upstreamCalls;
      await this.steps[name]();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.stepBudgetMs);
    });
    const outcome = await Promise.race([
      attempt.then(
        () => null,
        (error: unknown) => ({ error })
      ),
      budget,
    ]);
    clearTimeout(timer);
    const latencyMs = this.now() - startedAt;
    let errorClass: UserPathErrorClass | null = null;
    if (outcome === TIMED_OUT) errorClass = "timeout";
    else if (outcome !== null) {
      errorClass = latencyMs >= this.stepBudgetMs ? "timeout" : errorClassOf(outcome.error);
    }
    return {
      step: { step: name, result: errorClass === null ? "ok" : "failed", errorClass, latencyMs },
      upstreamCalls,
    };
  }
}
