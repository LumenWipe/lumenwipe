import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { isUnthrottledPath } from "./auth/rate-limiter";

/**
 * One source for the version the service reports. The OpenAPI document and the service index
 * at `/` both read it, so they cannot drift apart. Deliberately not read from package.json:
 * that file sits outside `rootDir`, so importing it would leave the require path dangling in
 * the built image (see the note in tsconfig.build.json).
 */
export const API_VERSION = "0.1.0";

/**
 * OpenAPI document configuration, shared by `main.ts` (which serves it at
 * `/docs` + `/docs-json`) and the spec test, so the published contract is the
 * one that's asserted.
 */
export function buildOpenApiConfig(): Omit<OpenAPIObject, "paths"> {
  const config = new DocumentBuilder()
    .setTitle("LumenWipe API")
    .setDescription(
      "Programmatic close-out of Stellar accounts. Request bodies must be JSON objects of at most 100 KB: a larger body is rejected with 413 payload_too_large, a non-JSON content type with 415 unsupported_media_type, and a body that is not a JSON object with 400 invalid_body."
    )
    .setVersion(API_VERSION)
    .setLicense("Apache-2.0", "https://www.apache.org/licenses/LICENSE-2.0.html")
    .addServer("https://api.lumenwipe.com")
    .addBearerAuth(
      // bearerFormat is set explicitly: the default is "JWT", but this credential
      // is an opaque integrator API key, not a JWT.
      { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Integrator API key" },
      "api-key"
    )
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque",
        description: "Short-lived wallet session token from POST /integrator/auth/session",
      },
      "integrator-session"
    )
    .addTag("close", "Build and submit an account close-out")
    .addTag("account", "Read account state and conversion paths")
    .addTag("mediator", "Exchange-destination forwarding")
    .addTag("stats", "Public close counter")
    .addTag("health", "Service health")
    .addTag("service", "Service index")
    .addTag("fee-bump", "Sponsored fees for reserve-locked accounts")
    .addTag("config", "Served configuration")
    .addTag("integrator", "Wallet-authenticated self-serve API key management")
    .build();
  // setContact() always writes an email key, and an empty one is not a valid address.
  config.info.contact = { name: "LumenWipe", url: "https://lumenwipe.com" };
  return config;
}

/** Stable serialization of the published contract, shared by the docs generator and its drift test. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

const RATE_LIMIT_HEADERS: Record<string, { description: string; schema: { type: "integer" } }> = {
  "RateLimit-Limit": {
    description: "Requests allowed in the current window for this API key (or client IP).",
    schema: { type: "integer" },
  },
  "RateLimit-Remaining": {
    description: "Requests left in the current window.",
    schema: { type: "integer" },
  },
  "RateLimit-Reset": {
    description: "Seconds until the window resets, or, on a 429, until the key is served again.",
    schema: { type: "integer" },
  },
  "Retry-After": {
    description: "Seconds to wait before retrying. Sent on 429 and 503.",
    schema: { type: "integer" },
  },
};

/**
 * The published document: the Nest-generated paths plus the rate-limit headers every throttled
 * route sends. Declared here, once, rather than on each of the hand-written responses.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  document.components = {
    ...document.components,
    headers: RATE_LIMIT_HEADERS,
  };
  for (const [path, item] of Object.entries(document.paths)) {
    if (isUnthrottledPath(path)) continue;
    for (const operation of Object.values(item as Record<string, unknown>)) {
      const responses = (operation as { responses?: Record<string, { headers?: object }> })
        .responses;
      for (const [status, response] of Object.entries(responses ?? {})) {
        const names = ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"];
        if (status === "429" || status === "503") names.push("Retry-After");
        response.headers = {
          ...response.headers,
          ...Object.fromEntries(
            names.map((name) => [name, { $ref: `#/components/headers/${name}` }])
          ),
        };
      }
    }
  }
  return document;
}
