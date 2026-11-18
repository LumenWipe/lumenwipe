// The only file that imports Next's routing internals (written against next 16.4.6, dist/):
// the functions `next start` runs for config redirects and headers
// (server/lib/router-utils/resolve-routes.js). A Next upgrade that moves them breaks this file alone.
import type { IncomingMessage } from "node:http";
import { stringify } from "node:querystring";
import { format } from "node:url";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  matchHas,
  prepareDestination,
} from "next/dist/shared/lib/router/utils/prepare-destination";
import type { Header, Redirect } from "next/dist/lib/load-custom-routes";

type Request = { host: string; url: string };

function match(rule: Redirect | Header, { host, url }: Request, restricted?: string[]) {
  const { pathname, searchParams } = new URL(url, "http://n");
  const query = Object.fromEntries(searchParams);
  const params = getPathMatch(rule.source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) => modifyRouteRegex(regex, restricted),
  })(pathname);
  if (!params) return null;
  const req = { headers: { host } } as unknown as IncomingMessage;
  const hasParams = rule.has || rule.missing ? matchHas(req, query, rule.has, rule.missing) : {};
  return hasParams ? { params: { ...params, ...hasParams }, query } : null;
}

/** The status and Location `next start` answers with, or null when no redirect matches. */
export function resolveRedirect(
  rules: Redirect[],
  request: Request
): { status: number; location: string } | null {
  for (const rule of rules) {
    const matched = match(rule, request, ["/_next"]);
    if (!matched) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: matched.params,
      query: matched.query,
    });
    const { query, ...destination } = parsedDestination;
    return {
      status:
        "statusCode" in rule && rule.statusCode ? rule.statusCode : rule.permanent ? 308 : 307,
      location: format({ ...destination, search: stringify(query) }),
    };
  }
  return null;
}

/** Every header the config's header rules set on a request, last rule winning. */
export function resolveHeaders(rules: Header[], request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (match(rule, request)) for (const { key, value } of rule.headers) headers[key] = value;
  }
  return headers;
}
