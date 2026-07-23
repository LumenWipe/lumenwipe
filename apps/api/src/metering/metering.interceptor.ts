import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import type { AuthedRequest } from "../auth/api-key.guard";
import { MeteringService } from "./metering.service";

/** Records one metered unit per successfully-handled request, keyed by integrator. */
@Injectable()
export class MeteringInterceptor implements NestInterceptor {
  constructor(private readonly metering: MeteringService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return next.handle().pipe(
      tap(() => {
        if (req.apiKeyLabel) this.metering.record(req.apiKeyLabel);
      })
    );
  }
}
