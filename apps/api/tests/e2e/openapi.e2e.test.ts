import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import { buildOpenApiConfig } from "@/openapi";

let app: INestApplication;
let spec: OpenAPIObject;

beforeAll(async () => {
  process.env.API_KEYS = "test=e2e_test_key";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  spec = SwaggerModule.createDocument(app, buildOpenApiConfig());
});

afterAll(async () => {
  await app.close();
});

test("spec declares the Bearer API-key security scheme", () => {
  expect(spec.components?.securitySchemes?.["api-key"]).toMatchObject({
    type: "http",
    scheme: "bearer",
    bearerFormat: "opaque", // not "JWT" — the credential is an opaque API key
  });
});

test("spec documents all v1 + read + mediator endpoints", () => {
  const paths = Object.keys(spec.paths);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/health",
      "/v1/{network}/close/plan",
      "/v1/{network}/close/transactions",
      "/v1/{network}/submit",
      "/{network}/account/{address}",
      "/{network}/paths",
      "/{network}/mediator/sign",
      "/{network}/mediator/check/{address}",
    ])
  );
});

test("request DTOs are present as schemas", () => {
  const schemas = Object.keys(spec.components?.schemas ?? {});
  expect(schemas).toEqual(
    expect.arrayContaining([
      "ClosePlanRequestDto",
      "CloseTransactionsRequestDto",
      "SubmitRequestDto",
      "MediatorSignRequestDto",
    ])
  );
});

test("health is public but the product endpoints require the api-key", () => {
  const health = spec.paths["/health"].get;
  const plan = spec.paths["/v1/{network}/close/plan"].post;
  // health carries no security requirement; close/plan requires api-key
  expect(health?.security ?? []).toEqual([]);
  expect(plan?.security).toEqual(expect.arrayContaining([{ "api-key": [] }]));
});
