import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";

// These cover the deterministic error contracts (validation / bad input) that
// require no network access, asserting the exact status + body shape the
// original Next route handlers returned. Success paths hit Stellar RPC and are
// exercised against testnet elsewhere, not here.

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

test("health returns ok", async () => {
  const res = await request(http).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});

test("close/plan rejects an invalid network with the v1 error shape", async () => {
  const res = await request(http).post("/v1/badnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: { code: "invalid_network", message: "Invalid network." } });
});

test("close/plan rejects a missing source", async () => {
  const res = await request(http).post("/v1/testnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: { code: "invalid_source", message: "A valid source account (G...) is required." },
  });
});

test("submit rejects a missing signedXdr", async () => {
  const res = await request(http).post("/v1/testnet/submit").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: "invalid_signed_xdr",
      message: "A signed transaction envelope (signedXdr) is required.",
    },
  });
});

test("paths rejects an invalid network with the plain error shape", async () => {
  const res = await request(http).get("/badnet/paths");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid network" });
});

test("paths rejects missing query params", async () => {
  const res = await request(http).get("/testnet/paths");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Missing fromAsset or amount" });
});

test("account rejects an invalid address", async () => {
  const res = await request(http).get("/testnet/account/NOPE");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid Stellar address" });
});

test("mediator/check rejects an invalid network before the address", async () => {
  const res = await request(http).get("/badnet/mediator/check/NOPE");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid network" });
});

test("mediator/check rejects an invalid address", async () => {
  const res = await request(http).get("/testnet/mediator/check/NOPE");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid address" });
});

test("malformed JSON on a v1 endpoint returns the invalid_body contract", async () => {
  const res = await request(http)
    .post("/v1/testnet/close/plan")
    .set("Content-Type", "application/json")
    .send('{ "source": ');
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: { code: "invalid_body", message: "Request body must be valid JSON." },
  });
});

test("malformed JSON on mediator/sign returns its plain error contract", async () => {
  const res = await request(http)
    .post("/testnet/mediator/sign")
    .set("Content-Type", "application/json")
    .send("{ not json");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid JSON body" });
});

test("responses carry Cache-Control: no-store (success and error)", async () => {
  const ok = await request(http).get("/health");
  expect(ok.headers["cache-control"]).toBe("no-store");
  const err = await request(http).get("/testnet/account/NOPE");
  expect(err.status).toBe(400);
  expect(err.headers["cache-control"]).toBe("no-store");
});
