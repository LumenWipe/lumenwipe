import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "@/app.module";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { C_ADDRESS, G_ADDRESS, W_ADDRESS, tampered } from "../unit/fixtures/contract-addresses";

const KEY = "e2e_test_key";

let app: INestApplication;

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger(() => undefined));
  await app.init();
});

afterAll(async () => {
  await app.close();
});

interface Route {
  name: string;
  /** The code the route answered with before this change, for a value that is not a strkey. */
  legacy: string;
  send: (address: string) => request.Test;
}

const authed = (test: request.Test): request.Test => test.set("Authorization", `Bearer ${KEY}`);
const get = (path: string) => authed(request(app.getHttpServer()).get(path));
const post = (path: string, body: unknown) =>
  authed(
    request(app.getHttpServer())
      .post(path)
      .send(body as object)
  );

const ROUTES: Route[] = [
  {
    name: "GET account/:address",
    legacy: "invalid_address",
    send: (a) => get(`/v1/testnet/account/${a}`),
  },
  {
    name: "GET allowances/:address",
    legacy: "invalid_address",
    send: (a) => get(`/v1/testnet/allowances/${a}`),
  },
  {
    name: "GET mediator/check/:address",
    legacy: "invalid_address",
    send: (a) => get(`/v1/testnet/mediator/check/${a}`),
  },
  {
    name: "POST allowances/revoke owner",
    legacy: "invalid_owner",
    send: (a) =>
      post("/v1/testnet/allowances/revoke", { owner: a, token: C_ADDRESS, spender: C_ADDRESS }),
  },
  {
    name: "POST close/plan source",
    legacy: "invalid_source",
    send: (a) => post("/v1/testnet/close/plan", { source: a }),
  },
  {
    name: "POST close/plan destination",
    legacy: "invalid_destination",
    send: (a) => post("/v1/testnet/close/plan", { source: G_ADDRESS, destination: a }),
  },
  {
    name: "POST close/batch-plan addresses",
    legacy: "invalid_addresses",
    send: (a) => post("/v1/testnet/close/batch-plan", { addresses: [G_ADDRESS, a] }),
  },
  {
    name: "POST close/batch-plan destination",
    legacy: "invalid_destination",
    send: (a) => post("/v1/testnet/close/batch-plan", { addresses: [G_ADDRESS], destination: a }),
  },
  {
    name: "POST close/transactions source",
    legacy: "invalid_source",
    send: (a) => post("/v1/testnet/close/transactions", { source: a, destination: G_ADDRESS }),
  },
  {
    name: "POST close/transactions destination",
    legacy: "invalid_destination",
    send: (a) => post("/v1/testnet/close/transactions", { source: G_ADDRESS, destination: a }),
  },
  {
    name: "GET close/status source",
    legacy: "invalid_source",
    send: (a) => get(`/v1/testnet/close/status?source=${a}`),
  },
  {
    name: "GET close/delivered destination",
    legacy: "invalid_destination",
    send: (a) => get(`/v1/testnet/close/delivered?destination=${a}&hashes=${"a".repeat(64)}`),
  },
];

for (const route of ROUTES) {
  describe(route.name, () => {
    test("a contract address is named as one", async () => {
      const res = await route.send(C_ADDRESS);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: "unsupported_address_type",
        details: { addressType: "contract" },
      });
      expect(res.body.error.message).toContain("contract address (C...)");
      expect(JSON.stringify(res.body)).not.toContain(C_ADDRESS);
    });

    test("a muxed contract address is named as one", async () => {
      const res = await route.send(W_ADDRESS);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: "unsupported_address_type",
        details: { addressType: "muxed_contract" },
      });
      expect(res.body.error.message).toContain("muxed contract address (W...)");
      expect(JSON.stringify(res.body)).not.toContain(W_ADDRESS);
    });

    test("anything that is not a valid strkey keeps the route's own code", async () => {
      for (const value of ["nope", tampered(C_ADDRESS), tampered(W_ADDRESS)]) {
        const res = await route.send(value);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(route.legacy);
      }
    });
  });
}
