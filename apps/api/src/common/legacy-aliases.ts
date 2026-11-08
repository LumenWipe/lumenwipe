import type { NextFunction, Request, RequestHandler, Response } from "express";

export const LEGACY_ALIAS_DEPRECATED_AT = new Date(Date.UTC(2026, 10, 9));

export const LEGACY_ALIAS_SUNSET_AT = new Date(Date.UTC(2027, 5, 1));

export const LEGACY_ALIAS_POLICY_URL =
  "https://docs.lumenwipe.com/api-reference/introduction#versioning";

export const DEPRECATION_HEADER_VALUE = `@${LEGACY_ALIAS_DEPRECATED_AT.getTime() / 1000}`;

export const SUNSET_HEADER_VALUE = LEGACY_ALIAS_SUNSET_AT.toUTCString();

// The prefixes these controllers had before they moved under /v1. Matched the way Express routes
// (case-insensitive, trailing slash allowed), so every request that reached one of them before
// reaches the same handler now.
const LEGACY_PREFIX = [
  /^\/(?:config|integrator)(?:\/.*)?$/i,
  /^\/[^/]+\/(?:account|allowances|paths|mediator|fee-bump)(?:\/.*)?$/i,
];

const NEVER_ALIASED = new Set(["v1", "docs", "health", "admin"]);

/** The canonical `/v1` path a legacy path is served by, or null when it is not a legacy path. */
export function legacyAliasTarget(pathname: string): string | null {
  const first = pathname.split("/")[1]?.toLowerCase() ?? "";
  if (NEVER_ALIASED.has(first)) return null;
  if (!LEGACY_PREFIX.some((pattern) => pattern.test(pathname))) return null;
  return `/v1${pathname}`;
}

// The successor path is the caller's own path reflected into a header, so anything that could end
// the `<...>` reference or start another link is percent-encoded.
function linkTarget(path: string): string {
  return path.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu, (ch) =>
    Array.from(
      new TextEncoder().encode(ch),
      (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    ).join("")
  );
}

export function legacyAliasLinkHeader(successorPath: string): string {
  return `<${linkTarget(successorPath)}>; rel="successor-version", <${LEGACY_ALIAS_POLICY_URL}>; rel="deprecation"`;
}

/**
 * Serves each pre-/v1 path as an alias of its /v1 route: the URL is rewritten before routing, so
 * the same guards, pipes, handler and metering run, and the request is counted once. Runs ahead
 * of the rate limiter so its 429, a 401 and a body error carry the deprecation headers too.
 */
export function legacyAliasMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const queryAt = req.url.indexOf("?");
    const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
    const target = legacyAliasTarget(pathname);
    if (target !== null) {
      req.url = queryAt === -1 ? target : `${target}${req.url.slice(queryAt)}`;
      res.setHeader("Deprecation", DEPRECATION_HEADER_VALUE);
      res.setHeader("Sunset", SUNSET_HEADER_VALUE);
      res.setHeader("Link", legacyAliasLinkHeader(target));
      res.locals.deprecatedAlias = true;
    }
    next();
  };
}
