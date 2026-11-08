import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { from, throwError, type Observable } from "rxjs";
import { catchError, concatMap } from "rxjs/operators";
import { KeyActivityService } from "./key-activity.service";
import { UpstreamMetricsService } from "./upstream-metrics.service";

/**
 * Gives the upstream counts and the key activity a chance to reach the store before the response
 * goes out, on a failed request too: those are the ones with failures to count. `/health*` stays
 * out of it.
 */
@Injectable()
export class UpstreamFlushInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: UpstreamMetricsService,
    private readonly activity: KeyActivityService
  ) {}

  private async flush(): Promise<void> {
    await Promise.all([this.metrics.flushIfDue(), this.activity.flushIfDue()]);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { path } = context.switchToHttp().getRequest<Request>();
    if (path.startsWith("/health")) return next.handle();
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.flush();
        return body;
      }),
      catchError((error: unknown) =>
        from(this.flush()).pipe(concatMap(() => throwError(() => error)))
      )
    );
  }
}
