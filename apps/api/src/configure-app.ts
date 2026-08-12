import type { INestApplication } from "@nestjs/common";
import { json } from "express";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";

/**
 * Shared runtime configuration applied by both `main.ts` (bootstrap) and the
 * e2e test harness, so what production runs is exactly what the tests exercise.
 *
 * Nest's built-in body parser is disabled (`bodyParser: false` at creation) so
 * we own the JSON error contract: a malformed body must return the original
 * routes' shape, not Nest's default `{ statusCode, message, error }`.
 */
export function configureApp(app: INestApplication): void {
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
    const body = req.path.includes("/mediator/")
      ? { error: "Invalid JSON body" }
      : { error: { code: "invalid_body", message: "Request body must be valid JSON." } };
    res.status(400).json(body);
  };
  app.use(onJsonError);
}
