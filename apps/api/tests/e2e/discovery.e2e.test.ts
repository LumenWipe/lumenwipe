import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import {
  API_CATALOG_CONTENT_TYPE,
  DISCOVERY_LINK_HEADER,
  type ApiCatalog,
} from "@/common/discovery-links";
import { JsonLogger } from "@/common/json-logger";
import { DOCS_SITE_URL } from "@/config/constants";
import { configureApp } from "@/configure-app";
import { createOpenApiDocument } from "@/openapi";

const KEY = "e2e_discovery_key";
const LIMIT = 120;
const DOCS_DIR = resolve(import.meta.dir, "../../../../docs");

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  process.env.API_KEYS = `discovery=${KEY}`;
  delete process.env.INTEGRATOR_SESSION_SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger(() => undefined));
  SwaggerModule.setup("docs", app, createOpenApiDocument(app));
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

let nextHost = 1;
const freshIp = (): { "X-Forwarded-For": string } => ({
  "X-Forwarded-For": `198.18.9.${nextHost++}`,
});

test("the catalog is an RFC 9727 linkset naming the OpenAPI document, the docs and the status", async () => {
  const res = await request(http).get("/.well-known/api-catalog");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe(`${API_CATALOG_CONTENT_TYPE}; charset=utf-8`);
  expect(JSON.parse(res.text)).toEqual({
    linkset: [
      {
        anchor: "/",
        "service-desc": [{ href: "/docs-json", type: "application/vnd.oai.openapi+json" }],
        "service-doc": [
          { href: "https://docs.lumenwipe.com/api-reference/introduction", type: "text/html" },
        ],
        status: [{ href: "/health", type: "application/json" }],
      },
    ],
  });
  expect(res.headers["ratelimit-limit"]).toBeUndefined();
});

test("HEAD on the catalog answers with the api-catalog link and no body", async () => {
  const res = await request(http).head("/.well-known/api-catalog");
  expect(res.status).toBe(200);
  expect(res.text).toBeUndefined();
  expect(res.headers["link"]).toContain('</.well-known/api-catalog>; rel="api-catalog"');
});

test("every catalog target resolves", async () => {
  const catalog = JSON.parse(
    (await request(http).get("/.well-known/api-catalog")).text
  ) as ApiCatalog;
  const targets = catalog.linkset.flatMap((entry) => [
    entry.anchor,
    ...[...entry["service-desc"], ...entry["service-doc"], ...entry.status].map((t) => t.href),
  ]);
  expect(targets).toHaveLength(4);
  for (const href of targets) {
    if (href.startsWith(`${DOCS_SITE_URL}/`)) {
      const page = href.slice(DOCS_SITE_URL.length + 1);
      expect(existsSync(resolve(DOCS_DIR, `${page}.mdx`)), href).toBe(true);
      continue;
    }
    expect(href.startsWith("/"), href).toBe(true);
    const res = await request(http).get(href).set(freshIp());
    expect(res.status, href).toBe(200);
  }
  const openapi = await request(http).get("/docs-json");
  expect(openapi.body.openapi).toStartWith("3.");
});

test("the Link header names the OpenAPI document, the docs, the status and the catalog", () => {
  expect(DISCOVERY_LINK_HEADER).toBe(
    '</docs-json>; rel="service-desc"; type="application/vnd.oai.openapi+json", ' +
      '<https://docs.lumenwipe.com/api-reference/introduction>; rel="service-doc", ' +
      '</health>; rel="status", ' +
      '</.well-known/api-catalog>; rel="api-catalog"'
  );
});

test("public, keyed, unknown and rejected responses all carry the Link header", async () => {
  const auth = { Authorization: `Bearer ${KEY}` };
  const cases: Array<[string, request.Test, number]> = [
    ["index", request(http).get("/"), 200],
    ["health", request(http).get("/health"), 200],
    ["openapi", request(http).get("/docs-json"), 200],
    ["keyed", request(http).get("/v1/config/exchange-registry").set(auth), 200],
    ["no key", request(http).get("/v1/testnet/account/G"), 401],
    ["unknown route", request(http).get("/no/such/route"), 404],
    [
      "malformed body",
      request(http)
        .post("/v1/testnet/close/plan")
        .set(auth)
        .set("Content-Type", "application/json")
        .send("{not json"),
      400,
    ],
    [
      "oversized body",
      request(http)
        .post("/v1/testnet/close/plan")
        .set(auth)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ pad: "x".repeat(200_000) })),
      413,
    ],
  ];
  for (const [name, pending, status] of cases) {
    const res = await pending.set(freshIp());
    expect(res.status, name).toBe(status);
    expect(res.headers["link"], name).toBe(DISCOVERY_LINK_HEADER);
  }
});

test("a kill-switch 503 carries the Link header", async () => {
  const saved = process.env.FEE_SPONSORSHIP_ENABLED;
  try {
    process.env.FEE_SPONSORSHIP_ENABLED = "false";
    const res = await request(http)
      .post("/v1/testnet/fee-bump/sponsor")
      .set("Authorization", `Bearer ${KEY}`)
      .set(freshIp())
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("fee_sponsorship_paused");
    expect(res.headers["link"]).toBe(DISCOVERY_LINK_HEADER);
  } finally {
    if (saved === undefined) delete process.env.FEE_SPONSORSHIP_ENABLED;
    else process.env.FEE_SPONSORSHIP_ENABLED = saved;
  }
});

test("the rate limiter's 429 carries the Link header", async () => {
  const caller = freshIp();
  for (let i = 0; i < LIMIT; i++) await request(http).get("/no/such/route").set(caller);
  const blocked = await request(http).get("/no/such/route").set(caller);
  expect(blocked.status).toBe(429);
  expect(blocked.headers["link"]).toBe(DISCOVERY_LINK_HEADER);
}, 20_000);

test("a legacy alias keeps its own links ahead of the discovery links", async () => {
  const res = await request(http)
    .get("/config/exchange-registry")
    .set("Authorization", `Bearer ${KEY}`)
    .set(freshIp());
  expect(res.status).toBe(200);
  expect(res.headers["link"]).toStartWith(
    '</v1/config/exchange-registry>; rel="successor-version"'
  );
  expect(res.headers["link"]).toEndWith(`, ${DISCOVERY_LINK_HEADER}`);
});

function routePaths(): string[] {
  const found: string[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const bases = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[]].flat();
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const subs = [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat();
        for (const base of bases) {
          for (const sub of subs) {
            found.push(`/${[base, sub].filter((p) => p && p !== "/").join("/")}`);
          }
        }
      }
    }
  }
  return found;
}

test("the API serves exactly one .well-known resource: the API catalog", () => {
  expect(routePaths().filter((path) => path.includes(".well-known"))).toEqual([
    "/.well-known/api-catalog",
  ]);
});

test("no OAuth, OpenID, agent card, MCP card or AI catalog is served", async () => {
  for (const name of [
    "openid-configuration",
    "oauth-authorization-server",
    "oauth-protected-resource",
    "agent-card.json",
    "agent.json",
    "mcp.json",
    "ai-catalog.json",
    "ard.json",
  ]) {
    const res = await request(http).get(`/.well-known/${name}`).set(freshIp());
    expect(res.status, name).toBe(404);
  }
});
