import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import SwaggerParser from "@apidevtools/swagger-parser";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import { buildOpenApiConfig, serializeOpenApiDocument } from "@/openapi";

const COMMITTED = resolve(import.meta.dir, "../../../../docs/api-reference/openapi.json");

const DOCS_JSON = resolve(import.meta.dir, "../../../../docs/docs.json");
const OPERATOR_AND_KEY_ISSUANCE_TAGS = new Set(["admin", "integrator"]);

let app: INestApplication;
let spec: OpenAPIObject;
let generated: string;

beforeAll(async () => {
  process.env.API_KEYS = "test=e2e_test_key";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  spec = SwaggerModule.createDocument(app, buildOpenApiConfig());
  generated = serializeOpenApiDocument(spec);
});

afterAll(async () => {
  await app.close();
});

test("docs/api-reference/openapi.json matches the spec the API serves", async () => {
  const committed = await readFile(COMMITTED, "utf8");
  expect(
    committed === generated,
    "docs/api-reference/openapi.json is stale. Regenerate it with: bun run --filter '@lumenwipe/api' openapi:generate"
  ).toBe(true);
});

function navigationPages(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(navigationPages);
  if (typeof node === "object" && node !== null && "pages" in node) {
    return navigationPages((node as { pages: unknown }).pages);
  }
  if (typeof node === "object" && node !== null && "groups" in node) {
    return navigationPages((node as { groups: unknown }).groups);
  }
  return [];
}

test("every public endpoint is listed in the docs navigation", async () => {
  const docs = JSON.parse(await readFile(DOCS_JSON, "utf8")) as { navigation: unknown };
  const listed = new Set(navigationPages(docs.navigation));
  const missing: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const tags = (operation as { tags?: string[] }).tags ?? [];
      if (tags.some((tag) => OPERATOR_AND_KEY_ISSUANCE_TAGS.has(tag))) continue;
      const entry = `${method.toUpperCase()} ${path}`;
      if (!listed.has(entry)) missing.push(entry);
    }
  }
  expect(missing, "add these endpoints to the API reference group in docs/docs.json").toEqual([]);
});

type Operation = { tags?: string[]; security?: Record<string, unknown>[]; requestBody?: unknown };

function operations(): { id: string; operation: Operation }[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({
        id: `${method.toUpperCase()} ${path}`,
        operation: operation as Operation,
      }))
  );
}

function refs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refs);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : refs(value)
  );
}

test("every security scheme an operation references is declared", () => {
  const declared = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
  const dangling = operations().flatMap(({ id, operation }) =>
    (operation.security ?? [])
      .flatMap((requirement) => Object.keys(requirement))
      .filter((name) => !declared.has(name))
      .map((name) => `${id} -> ${name}`)
  );
  expect(dangling).toEqual([]);
});

test("every tag an operation uses is declared", () => {
  const declared = new Set((spec.tags ?? []).map((tag) => tag.name));
  const undeclared = new Set(
    operations().flatMap(({ operation }) => (operation.tags ?? []).filter((t) => !declared.has(t)))
  );
  expect([...undeclared]).toEqual([]);
});

test("every $ref in the document resolves", () => {
  const unresolved = refs(spec).filter((ref) => {
    const [, ...segments] = ref.split("/");
    let node: unknown = spec;
    for (const segment of segments) {
      if (typeof node !== "object" || node === null || !(segment in node)) return true;
      node = (node as Record<string, unknown>)[segment];
    }
    return false;
  });
  expect(unresolved).toEqual([]);
});

test("every integrator operation documents its responses and any request body", () => {
  const integrator = operations().filter(({ id }) => id.includes(" /integrator/"));
  expect(integrator).toHaveLength(6);
  const bodyless = new Set([
    "GET /integrator/keys",
    "POST /integrator/keys",
    "POST /integrator/keys/{id}/revoke",
    "POST /integrator/keys/{id}/rotate",
  ]);
  const problems = integrator.flatMap(({ id, operation }) => {
    const found: string[] = [];
    const responses = (operation as { responses?: Record<string, { content?: unknown }> })
      .responses;
    const success = Object.entries(responses ?? {}).filter(([code]) => code.startsWith("2"));
    if (!success.every(([, response]) => response.content)) found.push(`${id}: no response schema`);
    if (Object.keys(responses ?? {}).length < 2) found.push(`${id}: no error responses`);
    if (!bodyless.has(id) && !operation.requestBody) found.push(`${id}: no request body`);
    return found;
  });
  expect(problems).toEqual([]);
});

test("the document is valid OpenAPI", async () => {
  await SwaggerParser.validate(structuredClone(spec) as never);
});
