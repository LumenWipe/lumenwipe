import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { API_KEY_STORE, InMemoryApiKeyStore } from "@/auth/api-key-store";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { issueSession } from "@/integrator/wallet-auth";
import { MediatorSigningService } from "@/mediator/mediator-signing.service";
import { InMemoryUsageStore, USAGE_STORE } from "@/metering/usage-store";

const INTEGRATOR_SECRET = "test-integrator-auth-secret-0123456789";
const WALLET = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();
const SESSION = issueSession(INTEGRATOR_SECRET, WALLET).token;

const saved = {
  secret: process.env.INTEGRATOR_AUTH_SECRET,
  firestore: process.env.FIRESTORE_PROJECT_ID,
};
const keys = new InMemoryApiKeyStore();
const usage = new InMemoryUsageStore();

async function start(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_KEY_STORE)
    .useValue(keys)
    .overrideProvider(USAGE_STORE)
    .useValue(usage)
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger(() => undefined));
  await app.init();
  return app;
}

let checkSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  checkSpy = spyOn(MediatorSigningService.prototype, "checkDestination").mockResolvedValue(
    {} as Awaited<ReturnType<MediatorSigningService["checkDestination"]>>
  );
  process.env.INTEGRATOR_AUTH_SECRET = INTEGRATOR_SECRET;
  process.env.FIRESTORE_PROJECT_ID = "usage-test-project";
});

afterAll(() => {
  checkSpy.mockRestore();
  for (const [name, value] of Object.entries({
    INTEGRATOR_AUTH_SECRET: saved.secret,
    FIRESTORE_PROJECT_ID: saved.firestore,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("each key's requests and 429s are listed per key and survive a restart", async () => {
  const limited = await keys.create(WALLET, { rateLimit: { limit: 2, ttlMs: 60_000 } });
  const other = await keys.create(WALLET);
  const first = await start();
  const call = (key: string) =>
    request(first.getHttpServer())
      .get(`/v1/testnet/mediator/check/${DESTINATION}`)
      .set("Authorization", `Bearer ${key}`)
      .set("X-Forwarded-For", "198.51.100.20");
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await call(limited.raw)).status);
  expect(statuses).toEqual([200, 200, 429, 429, 429]);
  await call(other.raw);
  await first.close();

  const restarted = await start();
  try {
    const res = await request(restarted.getHttpServer())
      .get("/v1/integrator/keys")
      .set("Authorization", `Bearer ${SESSION}`)
      .set("X-Forwarded-For", "198.51.100.21");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (res.body.keys as { id: string; usage: unknown }[]).map((k) => [k.id, k.usage])
    );
    expect(byId[limited.record.hash]).toEqual({
      today: 2,
      last30Days: 2,
      rateLimitedLast30Days: 3,
    });
    expect(byId[other.record.hash]).toEqual({ today: 1, last30Days: 1, rateLimitedLast30Days: 0 });
    expect(res.body.usage).toEqual({ today: 3, last30Days: 3 });
    expect(JSON.stringify(res.body)).not.toContain(DESTINATION);
    expect(JSON.stringify(res.body)).not.toContain("mediator");
  } finally {
    await restarted.close();
  }
});
