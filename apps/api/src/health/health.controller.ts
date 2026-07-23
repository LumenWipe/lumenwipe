import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
