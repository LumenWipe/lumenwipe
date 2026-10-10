import { type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { isValidNetwork } from "@/config/networks";
import { fail } from "@/common/fail";

/**
 * Nest runs a route's parameter pipes in reverse declaration order, so on a route that also
 * validates `:address` a request with both invalid would report the address. Guards run before
 * any pipe, so this pins the network check first and keeps the long-standing precedence.
 */
export class NetworkFirstGuard implements CanActivate {
  constructor(private readonly message = "Invalid network.") {}

  canActivate(context: ExecutionContext): boolean {
    const { network } = context.switchToHttp().getRequest<Request>().params;
    if (typeof network !== "string" || !isValidNetwork(network)) {
      fail("invalid_network", this.message, 400);
    }
    return true;
  }
}
