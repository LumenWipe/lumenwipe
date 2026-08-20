import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/public.decorator";
import { servedRegistry, type ServedRegistry } from "@/lib/exchange-registry";

/**
 * Serves the exchange registry.
 *
 * Public, because it is the same data the web would otherwise ship in its bundle and it
 * contains nothing an API key would protect - and because a client that cannot read it has to
 * fall back to a bundled floor, which is exactly the outcome this endpoint exists to make rare.
 *
 * Served rather than embedded for one reason: a stale registry and a compromised one cause the
 * same damage - funds sent somewhere that cannot credit them. Compromise needs an attacker;
 * staleness needs only time. Shipping the file to defend against the case that needs an
 * attacker guarantees the case that needs nobody.
 */
@ApiTags("config")
@Controller("config")
export class RegistryController {
  @Public()
  @Get("exchange-registry")
  @ApiOperation({
    summary: "The exchange deposit-address registry, with the freshness to judge it by.",
  })
  @ApiResponse({
    status: 200,
    description:
      "`entries` plus `lastVerified` and `validUntil`. A consumer MUST refuse to rely on this " +
      "past `validUntil` rather than proceed on unchecked data: a close into an exchange with " +
      "the wrong memo rule succeeds on-chain and is credited to nobody, with no error and no " +
      "source account left to investigate from.",
  })
  registry(): ServedRegistry {
    return servedRegistry();
  }
}
