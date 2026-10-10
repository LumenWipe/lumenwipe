import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import { buildOpenApiConfig } from "@/openapi";

const KEY = "e2e_test_key";
const METHODS = ["get", "post"] as const;

// Operations that have no failing input: they answer 200 whatever the caller sends.
const NO_ERROR_CASE = new Set([
  "GET /",
  "GET /health",
  "GET /health/deep",
  "GET /config/exchange-registry",
]);

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
let spec: OpenAPIObject;

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  delete process.env.INTEGRATOR_SESSION_SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
  spec = SwaggerModule.createDocument(app, buildOpenApiConfig());
});

afterAll(async () => {
  await app.close();
});

type Responses = Record<
  string,
  { content?: Record<string, { schema?: { allOf?: { properties?: unknown }[] } }> }
>;

function documentedCodes(responses: Responses, status: number): string[] | undefined {
  const allOf = responses[String(status)]?.content?.["application/json"]?.schema?.allOf;
  const code = (
    allOf?.[1]?.properties as
      { error?: { properties?: { code?: { enum?: string[] } } } } | undefined
  )?.error?.properties?.code;
  return code?.enum;
}

function invalidInput(path: string): { path: string; status: number; code: string } {
  if (path.startsWith("/integrator/")) {
    return { path, status: 503, code: "integrator_api_not_configured" };
  }
  return { path: path.replace("{network}", "nope"), status: 400, code: "invalid_network" };
}

test("every operation answers an invalid input with a documented status and the error envelope", async () => {
  const problems: string[] = [];
  let exercised = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = (item as Record<string, { responses: Responses } | undefined>)[method];
      if (!operation) continue;
      const id = `${method.toUpperCase()} ${path}`;
      if (NO_ERROR_CASE.has(id)) continue;
      const input = invalidInput(path);
      const url = input.path.replace(/\{[a-z]+\}/g, "x");
      const pending = method === "get" ? request(http).get(url) : request(http).post(url);
      const res = await pending
        .set("Authorization", `Bearer ${KEY}`)
        .send(method === "get" ? undefined : {});
      exercised++;
      const codes = documentedCodes(operation.responses, res.status);
      if (res.status !== input.status)
        problems.push(`${id}: expected ${input.status}, got ${res.status}`);
      else if (!codes)
        problems.push(`${id}: ${res.status} is not documented with the error schema`);
      else if (res.body?.error?.code !== input.code || typeof res.body.error.message !== "string") {
        problems.push(`${id}: body is not the envelope with ${input.code}`);
      } else if (!codes.includes(res.body.error.code)) {
        problems.push(`${id}: ${res.body.error.code} is not in the documented set`);
      }
    }
  }
  expect(problems).toEqual([]);
  expect(exercised).toBeGreaterThan(15);
  const others = Object.values(spec.paths)
    .flatMap((item) => Object.keys(item))
    .filter((m) => m !== "get" && m !== "post");
  expect(others).toEqual([]);
});
