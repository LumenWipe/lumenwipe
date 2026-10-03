import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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
