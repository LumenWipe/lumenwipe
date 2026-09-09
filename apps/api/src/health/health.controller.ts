import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";
import { Public } from "../auth/public.decorator";
import { rateLimitHits } from "@/lib/stellar/horizon-http";
import { buildRpcServer } from "@/lib/stellar/rpc";
import type { Network } from "@/config/networks";
import { VALID_NETWORKS } from "@/config/networks";

const RPC_HEALTH_TIMEOUT_MS = 3000;
// This route is public and unthrottled by design (an uptime monitor needs no API key), which
// otherwise means every request fans out into `VALID_NETWORKS.length` real outbound RPC calls
// with no limit on how often that can happen - a free amplification vector against the
// configured RPC providers, worse than useless during a real outage (hammering an already-
// struggling provider). Coalescing same-in-flight-or-recent results into one shared promise
// bounds the real call rate to at most once per this window, independent of how many requests
// arrive.
const DEEP_CHECK_CACHE_MS = 2000;

@ApiTags("health")
@Controller("health")
export class HealthController {
  private cachedDeepCheck: {
    result: ReturnType<HealthCheckService["check"]>;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: "Liveness check (public, no API key)." })
  @ApiResponse({
    status: 200,
    description:
      'Service is up: `{ "status": "ok", "upstreamRateLimitHits": n }`. The counter is how ' +
      "many upstream account-state requests the provider refused with 429 since this process " +
      "started. A rising value is the signal to point PATH_ROUTING_API_* at a provider with " +
      "more headroom, weeks before it becomes a user-visible outage.",
  })
  check(): { status: string; upstreamRateLimitHits: number } {
    // Exposed here because a counter nothing can read is not an early warning. It is a
    // lifetime total for this process, not a rate - with the service pinned at one instance
    // that is still the whole picture, but it would need aggregating if that ever changes.
    return { status: "ok", upstreamRateLimitHits: rateLimitHits() };
  }

  // Deliberately its own route, not a change to the check above (#59): `check()` is a cheap
  // liveness probe with no external dependency - Cloud Run's own startup check is a bare TCP
  // dial, not this endpoint, but nothing rules out an external uptime monitor already polling
  // it, and making it depend on RPC would turn a third-party provider's blip into this
  // service's reported downtime for no operational benefit. This is the separate, deeper
  // check: is Stellar RPC actually reachable on both networks right now.
  @Public()
  @SkipThrottle()
  @Get("deep")
  @HealthCheck()
  @ApiOperation({
    summary: "Deep check (public, no API key): is Stellar RPC reachable on every network.",
  })
  @ApiResponse({ status: 200, description: "RPC reachable on every network." })
  @ApiResponse({ status: 503, description: "RPC unreachable on at least one network." })
  deep(): ReturnType<HealthCheckService["check"]> {
    const now = Date.now();
    if (this.cachedDeepCheck && this.cachedDeepCheck.expiresAt > now) {
      return this.cachedDeepCheck.result;
    }
    const result = this.health.check(VALID_NETWORKS.map((network) => () => this.checkRpc(network)));
    this.cachedDeepCheck = { result, expiresAt: now + DEEP_CHECK_CACHE_MS };
    return result;
  }

  private async checkRpc(network: Network): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(`rpc_${network}`);
    try {
      // A dedicated, short-timeout server, never the shared getRpcServer() singleton every real
      // close operation uses - `timeout` here aborts the actual in-flight HTTP request (the SDK
      // wires it into a real AbortSignal), so an unreachable provider can't leave this route
      // holding an open outbound connection for however long that provider takes to give up.
      await buildRpcServer(network, { timeout: RPC_HEALTH_TIMEOUT_MS }).getHealth();
      return indicator.up();
    } catch (error) {
      return indicator.down(error instanceof Error ? error.message : String(error));
    }
  }
}
