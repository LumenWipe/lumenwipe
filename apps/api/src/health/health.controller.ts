import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: "Liveness check (public, no API key)." })
  @ApiResponse({ status: 200, description: 'Service is up: `{ "status": "ok" }`.' })
  check(): { status: string } {
    return { status: "ok" };
  }
}
