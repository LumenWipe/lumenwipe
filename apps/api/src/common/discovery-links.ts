import type { NextFunction, Request, RequestHandler, Response } from "express";
import { DOCS_SITE_URL } from "@/config/constants";

export const API_CATALOG_PATH = "/.well-known/api-catalog";

export const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

export const OPENAPI_PATH = "/docs-json";

export const STATUS_PATH = "/health";

export const SERVICE_DOC_URL = `${DOCS_SITE_URL}/api-reference/introduction`;

const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json";

/**
 * Sent on every response. Same-origin targets are relative so they resolve against whichever host
 * served the response, without reading the Host header.
 */
export const DISCOVERY_LINK_HEADER = [
  `<${OPENAPI_PATH}>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`,
  `<${SERVICE_DOC_URL}>; rel="service-doc"`,
  `<${STATUS_PATH}>; rel="status"`,
  `<${API_CATALOG_PATH}>; rel="api-catalog"`,
].join(", ");

export interface LinkTarget {
  href: string;
  type?: string;
}

export interface ApiCatalog {
  linkset: Array<{
    anchor: string;
    "service-desc": LinkTarget[];
    "service-doc": LinkTarget[];
    status: LinkTarget[];
  }>;
}

/** The RFC 9727 catalog: one API, described by the same links the Link header carries. */
export const API_CATALOG: ApiCatalog = {
  linkset: [
    {
      anchor: "/",
      "service-desc": [{ href: OPENAPI_PATH, type: OPENAPI_MEDIA_TYPE }],
      "service-doc": [{ href: SERVICE_DOC_URL, type: "text/html" }],
      status: [{ href: STATUS_PATH, type: "application/json" }],
    },
  ],
};

/**
 * Appends rather than sets, so a legacy alias's successor and deprecation links survive. Runs
 * ahead of the rate limiter so its 429 carries the links too.
 */
export function discoveryLinkMiddleware(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.append("Link", DISCOVERY_LINK_HEADER);
    next();
  };
}
