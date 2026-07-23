import { DocumentBuilder } from "@nestjs/swagger";

/**
 * OpenAPI document configuration, shared by `main.ts` (which serves it at
 * `/docs` + `/docs-json`) and the spec test, so the published contract is the
 * one that's asserted.
 */
export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle("LumenWipe API")
    .setDescription("Programmatic close-out of Stellar accounts.")
    .setVersion("0.1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", description: "Integrator API key" },
      "api-key"
    )
    .addTag("close", "Build and submit an account close-out")
    .addTag("account", "Read account state and conversion paths")
    .addTag("mediator", "Exchange-destination forwarding")
    .addTag("health", "Service health")
    .build();
}
