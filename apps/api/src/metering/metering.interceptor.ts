import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { concatMap } from "rxjs/operators";
import type { AuthedRequest } from "../auth/api-key.guard";
import { MeteringService } from "./metering.service";

/** Route pattern with the network filled in, so mainnet and testnet usage stay apart. */
export function meteredRoute(req: AuthedRequest): string {
  const path: string = req.route?.path ?? "unknown";
  const network: unknown = req.params?.network;
  return `${req.method} ${typeof network === "string" ? path.replace(":network", network) : path}`;
}

/**
 * Records one metered unit per successfully-handled request, keyed by integrator. The write is
 * awaited before the response goes out: Cloud Run throttles CPU once it has been sent.
 */
@Injectable()
export class MeteringInterceptor implements NestInterceptor {
  constructor(private readonly metering: MeteringService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return next.handle().pipe(
      concatMap(async (body) => {
        if (req.apiKeyLabel) await this.metering.record(req.apiKeyLabel, meteredRoute(req));
        return body;
      })
    );
  }
}
