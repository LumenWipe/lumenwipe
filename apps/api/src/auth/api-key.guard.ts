import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ApiKeyService } from "./api-key.service";
import { IS_PUBLIC_KEY } from "./public.decorator";

/** Request augmented with the resolved integrator identity, for metering. */
export interface AuthedRequest extends Request {
  apiKeyLabel?: string;
}

/**
 * Requires a valid API key on every route except those marked `@Public()`.
 * The key is sent as `Authorization: Bearer <key>`. There is no anonymous
 * access: the first-party web app supplies its key server-side via its proxy,
 * integrators via their own header.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

    const label = key ? this.apiKeys.resolve(key) : null;
    if (!label) {
      throw new UnauthorizedException({
        error: { code: "unauthorized", message: "A valid API key is required." },
      });
    }

    req.apiKeyLabel = label;
    return true;
  }
}
