import { DocumentBuilder } from "@nestjs/swagger";

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
    .setDescription("Programmatic close-out of Stellar accounts.")
    .setVersion(API_VERSION)
    .addBearerAuth(
      // bearerFormat is set explicitly: the default is "JWT", but this credential
      // is an opaque integrator API key, not a JWT.
      { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Integrator API key" },
      "api-key"
    )
    .addTag("close", "Build and submit an account close-out")
    .addTag("account", "Read account state and conversion paths")
    .addTag("mediator", "Exchange-destination forwarding")
    .addTag("health", "Service health")
    .addTag("service", "Service index")
    .build();
}
