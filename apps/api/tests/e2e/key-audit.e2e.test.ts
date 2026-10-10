import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import {
  API_KEY_STORE,
  InMemoryApiKeyStore,
  hashApiKey,
  type ApiKeyRecord,
} from "@/auth/api-key-store";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { issueSession } from "@/integrator/wallet-auth";

const ADMIN_TOKEN = "admin_audit_test_token";
const INTEGRATOR_SECRET = "integrator-audit-test-secret-0123456789";
const WALLET = Keypair.random().publicKey();
const OTHER_WALLET = Keypair.random().publicKey();
const SESSION = issueSession(INTEGRATOR_SECRET, WALLET).token;

class FlakyStore extends InMemoryApiKeyStore {
  broken = false;
  private guard<T>(run: () => Promise<T>): Promise<T> {
    return this.broken ? Promise.reject(new Error("store unavailable")) : run();
  }
  create(owner: string) {
    return this.guard(() => super.create(owner));
  }
  findByHash(hash: string) {
    return this.guard(() => super.findByHash(hash));
  }
  listByOwner(owner: string) {
    return this.guard(() => super.listByOwner(owner));
  }
  revoke(hash: string) {
    return this.guard(() => super.revoke(hash));
  }
  rotate(hash: string) {
    return this.guard(() => super.rotate(hash));
  }
}

const saved = {
  admin: process.env.ADMIN_API_TOKEN,
  secret: process.env.INTEGRATOR_AUTH_SECRET,
  firestore: process.env.FIRESTORE_PROJECT_ID,
};
const store = new FlakyStore();
const written: string[] = [];
let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.INTEGRATOR_AUTH_SECRET = INTEGRATOR_SECRET;
  process.env.FIRESTORE_PROJECT_ID = "audit-test-project";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_KEY_STORE)
    .useValue(store)
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger((line) => written.push(line)));
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
  for (const [name, value] of Object.entries({
    ADMIN_API_TOKEN: saved.admin,
    INTEGRATOR_AUTH_SECRET: saved.secret,
    FIRESTORE_PROJECT_ID: saved.firestore,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  written.length = 0;
  store.broken = false;
});

let ipCounter = 0;
const nextIp = (): string => `203.0.113.${(ipCounter = (ipCounter % 250) + 1)}`;

const admin = (path: string) =>
  request(http)
    .post(path)
    .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
    .set("X-Forwarded-For", nextIp());
const wallet = (path: string) =>
  request(http)
    .post(path)
    .set("Authorization", `Bearer ${SESSION}`)
    .set("X-Forwarded-For", nextIp());

const parsed = () => written.map((l) => JSON.parse(l) as Record<string, unknown>);
const audits = () => parsed().filter((l) => l.context === "audit");
const id = (hash: string) => hash.slice(0, 8);

async function seed(owner: string): Promise<ApiKeyRecord> {
  return (await store.create(owner)).record;
}

describe("admin key lifecycle lines", () => {
  test("create writes one success line without the raw key or hash", async () => {
    const res = await admin("/admin/api-keys").send({ owner: "acme" });
    expect(res.status).toBe(201);
    const line = audits();
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({
      event: "api_key.create",
      actor: "admin",
      keyId: id(res.body.record.id),
      owner: "acme",
      result: "success",
      requestId: res.headers["x-request-id"],
    });
    expect(written.join("\n")).not.toContain(res.body.key);
    expect(written.join("\n")).not.toContain(res.body.record.id);
    expect(written.join("\n")).not.toContain(ADMIN_TOKEN);
  });

  test("rotate writes one success line with the old and the new key id", async () => {
    const record = await seed("acme");
    const res = await admin(`/admin/api-keys/${record.hash}/rotate`);
    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      event: "api_key.rotate",
      keyId: id(record.hash),
      newKeyId: id(hashApiKey(res.body.key)),
      owner: "acme",
      result: "success",
    });
    expect(written.join("\n")).not.toContain(res.body.key);
    expect(written.join("\n")).not.toContain(record.hash);
  });

  test("revoke writes one success line", async () => {
    const record = await seed("acme");
    const res = await admin(`/admin/api-keys/${record.hash}/revoke`);
    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      event: "api_key.revoke",
      keyId: id(record.hash),
      owner: "acme",
      result: "success",
    });
  });

  test.each(["rotate", "revoke"] as const)(
    "%s of an unknown key writes one failure line",
    async (action) => {
      const unknown = hashApiKey("lw_never-issued");
      const res = await admin(`/admin/api-keys/${unknown}/${action}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("api_key_not_found");
      expect(audits()).toHaveLength(1);
      expect(audits()[0]).toMatchObject({
        event: `api_key.${action}`,
        keyId: id(unknown),
        owner: null,
        result: "failure",
      });
      expect(written.join("\n")).not.toContain(unknown);
    }
  );

  test("a store failure writes one failure line and the response stays a 500", async () => {
    store.broken = true;
    const created = await admin("/admin/api-keys").send({ owner: "acme" });
    const revoked = await admin(`/admin/api-keys/${hashApiKey("lw_x")}/revoke`);
    expect(created.status).toBe(500);
    expect(revoked.status).toBe(500);
    expect(audits().map((l) => [l.event, l.result])).toEqual([
      ["api_key.create", "failure"],
      ["api_key.revoke", "failure"],
    ]);
    expect(JSON.stringify(audits())).not.toContain("store unavailable");
  });

  test("a bad admin token and an invalid body are not lifecycle actions", async () => {
    const denied = await request(http)
      .post("/admin/api-keys")
      .set("Authorization", "Bearer wrong")
      .set("X-Forwarded-For", nextIp())
      .send({ owner: "acme" });
    const invalid = await admin("/admin/api-keys").send({ owner: "" });
    expect(denied.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(audits()).toHaveLength(0);
  });
});

describe("integrator key lifecycle lines", () => {
  test("create, rotate and revoke each write one line with the cut wallet address", async () => {
    const created = await wallet("/integrator/keys");
    expect(created.status).toBe(201);
    const rotated = await wallet(`/integrator/keys/${created.body.record.id}/rotate`);
    expect(rotated.status).toBe(200);
    const revoked = await wallet(`/integrator/keys/${rotated.body.record.id}/revoke`);
    expect(revoked.status).toBe(200);

    expect(audits().map((l) => [l.event, l.result])).toEqual([
      ["api_key.create", "success"],
      ["api_key.rotate", "success"],
      ["api_key.revoke", "success"],
    ]);
    expect(audits()[1]).toMatchObject({
      keyId: id(created.body.record.id),
      newKeyId: id(rotated.body.record.id),
    });
    for (const line of audits()) {
      expect(line.actor).toMatch(/^G[A-Z2-7]{3}\.\.\.[A-Z2-7]{4}~[0-9a-f]{8}$/);
      expect(line.owner).toBe(line.actor);
    }
    const everything = written.join("\n");
    for (const secret of [
      WALLET,
      SESSION,
      created.body.key,
      rotated.body.key,
      created.body.record.id,
      rotated.body.record.id,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  test.each(["rotate", "revoke"] as const)(
    "%s of another wallet's key writes one failure line",
    async (action) => {
      const foreign = await seed(OTHER_WALLET);
      const res = await wallet(`/integrator/keys/${foreign.hash}/${action}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("api_key_not_found");
      expect(audits()).toHaveLength(1);
      expect(audits()[0]).toMatchObject({
        event: `api_key.${action}`,
        result: "failure",
        keyId: id(foreign.hash),
      });
      expect(audits()[0]).not.toHaveProperty("newKeyId");
    }
  );

  test("the key limit writes one failure line and keeps its 409", async () => {
    const limited = Keypair.random().publicKey();
    const token = issueSession(INTEGRATOR_SECRET, limited).token;
    for (let i = 0; i < 5; i++) await seed(limited);
    const res = await request(http)
      .post("/integrator/keys")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Forwarded-For", nextIp());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("key_limit_reached");
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ event: "api_key.create", keyId: null, result: "failure" });
  });

  test("a store failure writes one failure line and the response stays a 500", async () => {
    const record = await seed(WALLET);
    store.broken = true;
    const res = await wallet(`/integrator/keys/${record.hash}/rotate`);
    expect(res.status).toBe(500);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ event: "api_key.rotate", result: "failure" });
  });

  test("a missing session is not a lifecycle action", async () => {
    const res = await request(http).post("/integrator/keys").set("X-Forwarded-For", nextIp());
    expect(res.status).toBe(401);
    expect(audits()).toHaveLength(0);
  });
});
