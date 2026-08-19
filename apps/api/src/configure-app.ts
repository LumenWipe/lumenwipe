import type { INestApplication } from "@nestjs/common";
import { json } from "express";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ErrorEnvelopeFilter } from "./common/error-envelope.filter";

/**
 * Shared runtime configuration applied by both `main.ts` (bootstrap) and the
 * e2e test harness, so what production runs is exactly what the tests exercise.
 *
 * Nest's built-in body parser is disabled (`bodyParser: false` at creation) so
 * we own the JSON error contract: a malformed body must return the original
 * routes' shape, not Nest's default `{ statusCode, message, error }`.
 */
export function configureApp(app: INestApplication): void {
  // Catches what the controllers do not: Nest raises 429 and 404 itself, in its own shape.
  app.useGlobalFilters(new ErrorEnvelopeFilter());

  // Every response is dynamic and non-cacheable (account state, plans, unsigned
  // XDR, mediator co-signatures) - no client, proxy, or CDN should store any of
  // it, success or error.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(json());

  const onJsonError: ErrorRequestHandler = (err, req, res, next) => {
    const isBodyParseError =
      err instanceof SyntaxError &&
      (err as SyntaxError & { type?: string }).type === "entity.parse.failed";
    if (!isBodyParseError) {
      next(err);
      return;
    }
    // One shape, whatever the path. This branched on `/mediator/` to keep two different error
    // contracts alive in the same handler - the clearest instance of the split #59 removes.
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: "Request body must be valid JSON." } });
  };
  app.use(onJsonError);
}
