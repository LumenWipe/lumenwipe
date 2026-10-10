import { DocumentBuilder, type OpenAPIObject } from "@nestjs/swagger";

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
export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle("LumenWipe API")
    .setDescription(
      "Programmatic close-out of Stellar accounts. Request bodies must be JSON objects of at most 100 KB: a larger body is rejected with 413 payload_too_large, a non-JSON content type with 415 unsupported_media_type, and a body that is not a JSON object with 400 invalid_body."
    )
    .setVersion(API_VERSION)
    .addServer("https://api.lumenwipe.com")
    .addBearerAuth(
      // bearerFormat is set explicitly: the default is "JWT", but this credential
      // is an opaque integrator API key, not a JWT.
      { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Integrator API key" },
      "api-key"
    )
    .addBearerAuth(
      // A distinct scheme from "api-key": admin routes are gated on a separate operator secret
      // (ADMIN_API_TOKEN), never an integrator key - see admin/admin.guard.ts.
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque",
        description: "Operator admin token",
      },
      "admin-token"
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
    .addTag("admin", "Operator-only self-serve API key management")
    .build();
}

/** Stable serialization of the published contract, shared by the docs generator and its drift test. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
