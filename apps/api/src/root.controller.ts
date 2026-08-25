import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "./auth/public.decorator";
import { API_VERSION } from "./openapi";

/** What `/` answers: enough to identify the service and find its documentation, nothing more. */
export interface ServiceIndex {
  name: string;
  version: string;
  docs: string;
  openapi: string;
  health: string;
}

@ApiTags("service")
@Controller()
export class RootController {
  // Public and unthrottled for the same reason /health is: this is what someone gets for typing
  // the bare hostname, and answering 401 or 404 there reads as "the deploy is broken" to anyone
  // who has not been handed a key yet. It exposes no account state and takes no input.
  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({ summary: "Service index (public, no API key)." })
  @ApiResponse({ status: 200, description: "Identifies the service and links to its docs." })
  index(): ServiceIndex {
    return {
      name: "LumenWipe API",
      version: API_VERSION,
      docs: "/docs",
      openapi: "/docs-json",
      health: "/health",
    };
  }
}
