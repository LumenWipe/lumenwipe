import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";

const KEY = "e2e_test_key";
const ADDRESS = Keypair.random().publicKey();

let app: INestApplication;

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
});

const ADDRESS_ROUTES = [
  { path: (n: string, a: string) => `/${n}/account/${a}`, message: "Invalid Stellar address" },
  { path: (n: string, a: string) => `/${n}/allowances/${a}`, message: "Invalid Stellar address" },
  { path: (n: string, a: string) => `/${n}/mediator/check/${a}`, message: "Invalid address" },
];

for (const route of ADDRESS_ROUTES) {
  test(`${route.path("{network}", "{address}")} reports the network first when both are invalid`, async () => {
    const res = await request(app.getHttpServer())
      .get(route.path("nope", "x"))
      .set("Authorization", `Bearer ${KEY}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "invalid_network", message: "Invalid network" },
    });
  });

  test(`${route.path("{network}", "{address}")} rejects only the address on a valid network`, async () => {
    const res = await request(app.getHttpServer())
      .get(route.path("testnet", "x"))
      .set("Authorization", `Bearer ${KEY}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_address", message: route.message } });
  });
}

test("a bad network on a close route keeps its trailing-period message", async () => {
  const res = await request(app.getHttpServer())
    .post("/v1/nope/close/plan")
    .set("Authorization", `Bearer ${KEY}`)
    .send({ source: ADDRESS });
  expect(res.body).toMatchObject({
    error: { code: "invalid_network", message: "Invalid network." },
  });
});
