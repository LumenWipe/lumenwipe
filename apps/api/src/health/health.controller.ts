import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { rateLimitHits } from "@/lib/stellar/horizon-http";

@ApiTags("health")
@Controller("health")
export class HealthController {
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
}
