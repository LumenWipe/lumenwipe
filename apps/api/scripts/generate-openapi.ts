/**
 * Writes the OpenAPI document the docs site renders its REST reference from.
 *
 * Generated from the application code rather than fetched from a deployed API, so the reference
 * can never describe a build older than the branch it ships with. tests/e2e/openapi-drift.e2e.test.ts
 * fails when the committed file is stale.
 *
 *   bun run --filter '@lumenwipe/api' openapi:generate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import { buildOpenApiConfig, serializeOpenApiDocument } from "@/openapi";

const OUTPUT = resolve(import.meta.dir, "../../../docs/api-reference/openapi.json");

process.env.API_KEYS ??= "docs=openapi_generation_only";

const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
const app = moduleRef.createNestApplication({ bodyParser: false });
configureApp(app);
await app.init();

const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, serializeOpenApiDocument(document));
await app.close();

console.log(`wrote ${OUTPUT}`);
