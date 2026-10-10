import type { INestApplication } from "@nestjs/common";
import { json } from "express";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ErrorEnvelopeFilter } from "./common/error-envelope.filter";

export const JSON_BODY_LIMIT = "100kb";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const BODY_PARSER_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  "entity.parse.failed": {
    status: 400,
    code: "invalid_body",
    message: "Request body must be valid JSON.",
  },
  "entity.too.large": {
    status: 413,
    code: "payload_too_large",
    message: `Request body must be at most ${JSON_BODY_LIMIT}.`,
  },
  "charset.unsupported": {
    status: 415,
    code: "unsupported_media_type",
    message: "Request body must be UTF-8 encoded JSON.",
  },
  "encoding.unsupported": {
    status: 415,
    code: "unsupported_media_type",
    message: "Request body must not use a content encoding.",
  },
};

/**
 * Shared runtime configuration applied by both `main.ts` (bootstrap) and the
 * e2e test harness, so what production runs is exactly what the tests exercise.
 *
 * Nest's built-in body parser is disabled (`bodyParser: false` at creation) so
 * we own the JSON error contract: a malformed body must return the original
 * routes' shape, not Nest's default `{ statusCode, message, error }`.
 */
export function configureApp(app: INestApplication): void {
  // Cloud Run terminates TLS and proxies every request through its own frontend - without this,
  // Express's req.ip reports that proxy's address for every request, not the real caller's, so
  // ApiKeyThrottlerGuard's per-IP fallback (unauthenticated requests, which carry no API key to
  // key off instead) collapses onto one shared bucket for all callers combined (#59). Cloud
  // Run's proxy is trusted infrastructure the request cannot have come from any other way, so
  // trusting it to report the real client in X-Forwarded-For is safe here.
  app.getHttpAdapter().getInstance().set("trust proxy", true);

  // Catches what the controllers do not: Nest raises 429 and 404 itself, in its own shape.
  app.useGlobalFilters(new ErrorEnvelopeFilter());

  // Every response is dynamic and non-cacheable (account state, plans, unsigned
  // XDR, mediator co-signatures) - no client, proxy, or CDN should store any of
  // it, success or error.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(json({ limit: JSON_BODY_LIMIT }));

  const onJsonError: ErrorRequestHandler = (err, _req, res, next) => {
    const type = (err as { type?: unknown } | null)?.type;
    const zlibCode = (err as { code?: unknown } | null)?.code;
    const corruptEncoding = typeof zlibCode === "string" && zlibCode.startsWith("Z_");
    const mapped = corruptEncoding
      ? BODY_PARSER_ERRORS["entity.parse.failed"]
      : typeof type === "string"
        ? BODY_PARSER_ERRORS[type]
        : undefined;
    if (!mapped) {
      next(err);
      return;
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  };
  app.use(onJsonError);

  // Express 5 leaves req.body undefined when no JSON was parsed, and handlers destructure it.
  const normalizeBody: RequestHandler = (req, res, next) => {
    if (!BODY_METHODS.has(req.method)) {
      next();
      return;
    }
    const hasContent =
      req.headers["content-type"] !== undefined && req.headers["content-length"] !== "0";
    if (hasContent && req.is("json") === false) {
      res.status(415).json({
        error: {
          code: "unsupported_media_type",
          message: "Request body must be JSON (Content-Type: application/json).",
        },
      });
      return;
    }
    if (req.body === undefined) {
      req.body = {};
    } else if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      res
        .status(400)
        .json({ error: { code: "invalid_body", message: "Request body must be a JSON object." } });
      return;
    }
    next();
  };
  app.use(normalizeBody);
}
