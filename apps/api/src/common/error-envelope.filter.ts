import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";

/**
 * Puts every error the service emits into one envelope.
 *
 * Converting the controllers was not enough. Nest's own default filter answers a throttled
 * request with `{ statusCode: 429, message: "ThrottlerException: Too Many Requests" }` and an
 * unknown route with `{ message, error, statusCode }` - neither has an `error.code`, so a
 * client written against the documented contract finds nothing to branch on. Rate limiting is
 * arguably the error an integrator meets most often, so leaving it in a third shape would have
 * kept the split alive at exactly the wrong place.
 *
 * Bodies that already carry the envelope pass through untouched, so nothing a controller says
 * is rewritten here.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger("errors");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === "object" && body !== null && "error" in body) {
        const inner = (body as { error: unknown }).error;
        // Already the envelope - emit verbatim rather than re-wrapping a message into a code.
        if (typeof inner === "object" && inner !== null) {
          res.status(status).json(body);
          return;
        }
      }

      const message =
        typeof body === "string"
          ? body
          : ((body as { message?: unknown }).message ?? exception.message);
      res.status(status).json({
        error: {
          code: codeForStatus(status),
          message: Array.isArray(message) ? message.join("; ") : String(message),
        },
      });
      return;
    }

    // An unexpected throw. The message is deliberately not forwarded: it is the one class of
    // error whose text was never written for a user, and the invariant is that user-facing
    // errors are plain language, never raw internals.
    this.logger.error(
      "Unhandled exception",
      exception instanceof Error ? exception.stack : String(exception)
    );
    res.status(500).json({
      error: { code: "internal_error", message: "Something went wrong. Please try again." },
    });
  }
}

/** A stable code for the statuses Nest raises on its own. */
function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : "request_failed";
  }
}
