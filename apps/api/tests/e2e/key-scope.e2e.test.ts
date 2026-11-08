import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { API_KEY_STORE, InMemoryApiKeyStore } from "@/auth/api-key-store";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { issueSession } from "@/integrator/wallet-auth";
import { KEY_ACTIVITY_FLUSH_INTERVAL_MS } from "@/metering/key-activity.service";
import { METERING_CLOCK } from "@/metering/metering.service";
import { InMemoryUsageStore, USAGE_STORE } from "@/metering/usage-store";
import { takeBlockedRequests } from "../no-network";

const INTEGRATOR_SECRET = "test-integrator-auth-secret-0123456789";
const WALLET = Keypair.random().publicKey();
const SESSION = issueSession(INTEGRATOR_SECRET, WALLET).token;
const ACCOUNT = Keypair.random().publicKey();

const saved = {
  secret: process.env.INTEGRATOR_AUTH_SECRET,
  firestore: process.env.FIRESTORE_PROJECT_ID,
};
const store = new InMemoryApiKeyStore();
const logs: string[] = [];
let now = Date.parse("2026-11-08T12:00:00Z");
let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  process.env.INTEGRATOR_AUTH_SECRET = INTEGRATOR_SECRET;
  process.env.FIRESTORE_PROJECT_ID = "scope-test-project";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_KEY_STORE)
    .useValue(store)
    .overrideProvider(USAGE_STORE)
    .useValue(new InMemoryUsageStore())
    .overrideProvider(METERING_CLOCK)
    .useValue(() => new Date(now))
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger((line) => logs.push(line)));
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
  for (const [name, value] of Object.entries({
    INTEGRATOR_AUTH_SECRET: saved.secret,
    FIRESTORE_PROJECT_ID: saved.firestore,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let ipCounter = 0;
const nextIp = (): string => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}`;

const createKey = async (body: Record<string, unknown>) => {
  const res = await request(http)
    .post("/v1/integrator/keys")
    .set("Authorization", `Bearer ${SESSION}`)
    .set("X-Forwarded-For", nextIp())
    .send(body);
  expect(res.status).toBe(201);
  return res.body as { key: string; record: { id: string } };
};

const listKeys = async () => {
  const res = await request(http)
    .get("/v1/integrator/keys")
    .set("Authorization", `Bearer ${SESSION}`)
    .set("X-Forwarded-For", nextIp());
  expect(res.status).toBe(200);
  return res.body as { keys: Record<string, unknown>[] };
};

const call = (path: string, key: string) =>
  request(http).get(path).set("Authorization", `Bearer ${key}`).set("X-Forwarded-For", nextIp());

describe("network-scoped keys", () => {
  test("a key created with networks keeps them, and the list returns label and lastUsedAt", async () => {
    const { record } = await createKey({ label: "staging", networks: ["testnet"] });
    const listed = (await listKeys()).keys.find((k) => k.id === record.id);
    expect(listed).toMatchObject({ label: "staging", networks: ["testnet"], lastUsedAt: null });
  });

  test("a testnet key is refused on mainnet before any upstream call", async () => {
    const { key } = await createKey({ networks: ["testnet"] });
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const res = await call(`/v1/mainnet/account/${ACCOUNT}`, key);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "key_network_not_allowed" } });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(takeBlockedRequests()).toEqual([]);
    const line = logs.map((l) => JSON.parse(l) as Record<string, unknown>).at(-1);
    expect(line?.status).toBe(403);
    expect(line?.upstreamCalls).toBeUndefined();
  });

  test("the legacy alias of a mainnet route refuses it the same way", async () => {
    const { key } = await createKey({ networks: ["testnet"] });
    const res = await call(`/mainnet/account/${ACCOUNT}`, key);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "key_network_not_allowed" } });
  });

  test("a testnet key reaches the testnet route", async () => {
    const { key } = await createKey({ networks: ["testnet"] });
    const res = await call("/v1/testnet/account/not-an-address", key);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_address" } });
  });

  test("a key created without networks works on both networks as before", async () => {
    const { key, record } = await createKey({});
    for (const network of ["mainnet", "testnet"]) {
      const res = await call(`/v1/${network}/account/not-an-address`, key);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "invalid_address" } });
    }
    const listed = (await listKeys()).keys.find((k) => k.id === record.id);
    expect(listed).toMatchObject({ label: null, networks: null });
  });

  test("a malformed networks value is refused without creating a key", async () => {
    const before = (await listKeys()).keys.length;
    const res = await request(http)
      .post("/v1/integrator/keys")
      .set("Authorization", `Bearer ${SESSION}`)
      .set("X-Forwarded-For", nextIp())
      .send({ networks: ["futurenet"] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "invalid_networks" } });
    expect((await listKeys()).keys).toHaveLength(before);
  });
});

describe("lastUsedAt", () => {
  test("costs one write per interval however many requests the key makes", async () => {
    const owner = Keypair.random().publicKey();
    const session = issueSession(INTEGRATOR_SECRET, owner).token;
    const created = await request(http)
      .post("/v1/integrator/keys")
      .set("Authorization", `Bearer ${session}`)
      .set("X-Forwarded-For", nextIp())
      .send({});
    const { key, record } = created.body as { key: string; record: { id: string } };
    const writes = spyOn(store, "recordLastUsed");
    try {
      now += KEY_ACTIVITY_FLUSH_INTERVAL_MS;
      await call("/v1/testnet/account/not-an-address", key);
      const firstUse = now;
      expect(writes).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        now += 1_000;
        await call("/v1/testnet/account/not-an-address", key);
      }
      expect(writes).toHaveBeenCalledTimes(1);
      expect((await store.findByHash(record.id))!.lastUsedAt?.getTime()).toBe(firstUse);
      now += KEY_ACTIVITY_FLUSH_INTERVAL_MS;
      await call("/v1/testnet/account/not-an-address", key);
      expect(writes).toHaveBeenCalledTimes(2);
      expect((await store.findByHash(record.id))!.lastUsedAt?.getTime()).toBe(now);
      const listed = await request(http)
        .get("/v1/integrator/keys")
        .set("Authorization", `Bearer ${session}`)
        .set("X-Forwarded-For", nextIp());
      expect(listed.body.keys[0].lastUsedAt).toBe(new Date(now).toISOString());
    } finally {
      writes.mockRestore();
    }
  });
});
