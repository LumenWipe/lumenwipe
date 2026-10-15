import type { INestApplication, LoggerService } from "@nestjs/common";
import type { ErrorCode } from "@lumenwipe/types";
import { json } from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { RateLimiter } from "./auth/rate-limiter";
import { ErrorEnvelopeFilter } from "./common/error-envelope.filter";
import { JsonLogger } from "./common/json-logger";
import { registerRequestSecrets, requestContextMiddleware } from "./common/request-context";

export const JSON_BODY_LIMIT = "100kb";

export const TRUSTED_PROXY_HOPS = 1;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const BODY_PARSER_ERRORS: Record<string, { status: number; code: ErrorCode; message: string }> = {
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
export function configureApp(
  app: INestApplication,
  logger: LoggerService = new JsonLogger()
): void {
  // Cloud Run's front end keeps any X-Forwarded-For the caller sent and appends the address it
  // accepted the connection from, so only the last entry is trustworthy. Exactly one hop: an
  // external load balancer in front of the service would add a second entry and need 2.
  app.getHttpAdapter().getInstance().set("trust proxy", TRUSTED_PROXY_HOPS);

  app.useLogger(logger);

  // First, ahead of the rate limiter, body parsing and authentication, so the limiter's own 429,
  // a 401 and a body error all carry x-request-id. Also sets Cache-Control: no-store: every
  // response is dynamic and non-cacheable (account state, plans, unsigned XDR, mediator
  // co-signatures), success or error. Order: request context, rate limiter, filters, body
  // parser, body-error mapping, body normalization, secret registration.
  app.use(requestContextMiddleware());

  // Ahead of body parsing, routing and authentication, so the budget is spent and
  // reported on every response, including a 404 or a rejected body.
  app.use(app.get(RateLimiter).middleware());

  // Catches what the controllers do not: Nest raises 429 and 404 itself, in its own shape.
  app.useGlobalFilters(new ErrorEnvelopeFilter());

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
  app.use(registerRequestSecrets);
}
