import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { fail } from "@/common/fail";
import { KeyActivityService } from "@/metering/key-activity.service";
import { ApiKeyDirectory, type ResolvedApiKey } from "./api-key-directory";
import { IS_NETWORK_AGNOSTIC_KEY } from "./network-agnostic.decorator";
import { IS_PUBLIC_KEY } from "./public.decorator";

/** Request augmented with the resolved integrator identity, for metering. */
export interface AuthedRequest extends Request {
  apiKeyLabel?: string;
  /** The self-serve key's id; absent for a manually provisioned key. */
  apiKeyId?: string;
}

/**
 * Requires a valid API key on every route except those marked `@Public()`.
 * The key is sent as `Authorization: Bearer <key>`. There is no anonymous
 * access: the first-party web app supplies its key server-side via its proxy,
 * integrators via their own header.
 *
 * A key scoped to some networks is refused (403) on any other `:network`, and on every route
 * without one unless it is `@NetworkAgnostic()`. Guards run before pipes and handlers, so a
 * refused request never reaches an upstream.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyDirectory,
    private readonly activity: KeyActivityService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.flag(context, IS_PUBLIC_KEY)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

    const resolved = key ? await this.apiKeys.resolve(key) : null;
    if (!resolved) {
      throw new UnauthorizedException({
        error: { code: "unauthorized", message: "A valid API key is required." },
      });
    }
    if (!this.inScope(resolved, req.params?.network, context)) {
      fail("key_network_not_allowed", "This API key is not allowed on this network.", 403);
    }

    req.apiKeyLabel = resolved.label;
    if (resolved.id) {
      req.apiKeyId = resolved.id;
      this.activity.touch(resolved.id);
    }
    return true;
  }

  private inScope(resolved: ResolvedApiKey, network: unknown, context: ExecutionContext): boolean {
    if (resolved.networks === null) return true;
    if (typeof network === "string") return (resolved.networks as string[]).includes(network);
    return this.flag(context, IS_NETWORK_AGNOSTIC_KEY);
  }

  private flag(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) ===
      true
    );
  }
}
