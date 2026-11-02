import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { from, throwError, type Observable } from "rxjs";
import { catchError, concatMap } from "rxjs/operators";
import { UpstreamMetricsService } from "./upstream-metrics.service";

/**
 * Gives the upstream counts a chance to reach the store before the response goes out, on a
 * failed request too: those are the ones with failures to count. `/health*` stays out of it.
 */
@Injectable()
export class UpstreamFlushInterceptor implements NestInterceptor {
  constructor(private readonly metrics: UpstreamMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { path } = context.switchToHttp().getRequest<Request>();
    if (path.startsWith("/health")) return next.handle();
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.metrics.flushIfDue();
        return body;
      }),
      catchError((error: unknown) =>
        from(this.metrics.flushIfDue()).pipe(concatMap(() => throwError(() => error)))
      )
    );
  }
}
