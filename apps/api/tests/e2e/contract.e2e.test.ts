import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";

// Deterministic error/auth contracts that need no network access, asserting the
// exact status + body the API returns. Success paths hit Stellar RPC and are
// exercised against testnet elsewhere, not here.

const KEY = "e2e_test_key";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

// Authenticated request helpers - every route except /health requires the key.
const authGet = (path: string) => request(http).get(path).set("Authorization", `Bearer ${KEY}`);
const authPost = (path: string) => request(http).post(path).set("Authorization", `Bearer ${KEY}`);

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

// ─── Auth ──────────────────────────────────────────────────────────────────

test("health is public (no key required)", async () => {
  const res = await request(http).get("/health");
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("ok");
  // Surfaced so an operator can see the upstream provider refusing requests before it becomes
  // an outage; a lifetime count for this process, so only its trend is meaningful.
  expect(typeof res.body.upstreamRateLimitHits).toBe("number");
});

test("an authenticated route without a key is rejected 401", async () => {
  const res = await request(http).get("/testnet/account/NOPE");
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
});

test("an authenticated route with an unknown key is rejected 401", async () => {
  const res = await request(http).get("/testnet/account/NOPE").set("Authorization", "Bearer nope");
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
});

// ─── Error contracts (with a valid key) ──────────────────────────────────────

test("close/plan rejects an invalid network with the v1 error shape", async () => {
  const res = await authPost("/v1/badnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: { code: "invalid_network", message: "Invalid network." } });
});

test("close/plan rejects a missing source", async () => {
  const res = await authPost("/v1/testnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: { code: "invalid_source", message: "A valid source account (G...) is required." },
  });
});

test("submit rejects a missing signedXdr", async () => {
  const res = await authPost("/v1/testnet/submit").send({});
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: "invalid_signed_xdr",
      message: "A signed transaction envelope (signedXdr) is required.",
    },
  });
});

// One envelope across the whole API now: `{ error: { code, message, details? } }`. These used
// to assert a flat `{ error: "..." }` on account/paths/mediator while auth returned the
// structured form, which is why apps/web/lib/api/close-client.ts still carries a ternary that
// checks whether `error` is an object or a string before it can find the message.
test("paths rejects an invalid network with the unified error envelope", async () => {
  const res = await authGet("/badnet/paths");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_network");
  expect(typeof res.body.error.message).toBe("string");
});

test("paths rejects missing query params", async () => {
  const res = await authGet("/testnet/paths");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("missing_parameters");
});

test("account rejects an invalid address", async () => {
  const res = await authGet("/testnet/account/NOPE");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_address");
});

test("mediator/check rejects an invalid network before the address", async () => {
  const res = await authGet("/badnet/mediator/check/NOPE");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_network");
});

test("mediator/check rejects an invalid address", async () => {
  const res = await authGet("/testnet/mediator/check/NOPE");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_address");
});

test("malformed JSON on a v1 endpoint returns the invalid_body contract", async () => {
  const res = await authPost("/v1/testnet/close/plan")
    .set("Content-Type", "application/json")
    .send('{ "source": ');
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: { code: "invalid_body", message: "Request body must be valid JSON." },
  });
});

test("malformed JSON on mediator/sign returns its plain error contract", async () => {
  const res = await authPost("/testnet/mediator/sign")
    .set("Content-Type", "application/json")
    .send("{ not json");
  expect(res.status).toBe(400);
  // Was a second, mediator-only shape emitted by the very same handler.
  expect(res.body.error.code).toBe("invalid_body");
});

test("responses carry Cache-Control: no-store (success and error)", async () => {
  const ok = await request(http).get("/health");
  expect(ok.headers["cache-control"]).toBe("no-store");
  const err = await authGet("/testnet/account/NOPE");
  expect(err.status).toBe(400);
  expect(err.headers["cache-control"]).toBe("no-store");
});

test("close/transactions rejects a text memo over 28 bytes with 422 (before any network read)", async () => {
  const res = await authPost("/v1/testnet/close/transactions").send({
    source: Keypair.random().publicKey(),
    destination: Keypair.random().publicKey(),
    memo: "x".repeat(29),
  });
  expect(res.status).toBe(422);
  expect(res.body).toEqual({
    error: { code: "invalid_memo", message: "A text memo must be at most 28 bytes." },
  });
});

// The plan endpoint surfaces this as a decision, but the plan is advisory: an SDK caller can
// reach /close/transactions without ever requesting one, so the refusal has to live here too.
test("close/transactions refuses an unacknowledged unrecognized destination with 422 (before any network read)", async () => {
  const destination = Keypair.random().publicKey();
  const res = await authPost("/v1/testnet/close/transactions").send({
    source: Keypair.random().publicKey(),
    destination,
  });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("destination_not_acknowledged");
  // The details tell a caller exactly which decision to answer and with what, so an SDK
  // integrator can recover from the 422 without reading our source. The decision id names the
  // destination, so the answer cannot be replayed for a different one.
  expect(res.body.error.details).toEqual({
    decisionId: `destination:${destination}`,
    choice: "i_control_this_address",
  });
});

test("close/transactions does not accept an acknowledgement given for a different destination", async () => {
  const res = await authPost("/v1/testnet/close/transactions").send({
    source: Keypair.random().publicKey(),
    destination: Keypair.random().publicKey(),
    decisions: [
      {
        id: `destination:${Keypair.random().publicKey()}`,
        choice: "i_control_this_address",
      },
    ],
  });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("destination_not_acknowledged");
});

test("close/transactions survives malformed decision entries with a typed error, not a 500", async () => {
  const res = await authPost("/v1/testnet/close/transactions").send({
    source: Keypair.random().publicKey(),
    destination: Keypair.random().publicKey(),
    decisions: [null, 42],
  });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("destination_not_acknowledged");
});

test("close/transactions does not demand an acknowledgement for a recognized exchange destination", async () => {
  // A registry entry that requires a memo: it fails on the missing memo, which proves the
  // acknowledgement gate was never reached, and stays network-free.
  const res = await authPost("/v1/testnet/close/transactions").send({
    source: Keypair.random().publicKey(),
    destination: "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
  });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("memo_required");
});

test("an unknown route answers in the same envelope as everything else", async () => {
  // Nest's default filter emits `{ statusCode, message, error }` with no `error.code`, so a
  // client written against the documented contract finds nothing to branch on. Converting the
  // controllers alone left this third shape alive.
  const res = await authGet("/testnet/no-such-route");
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe("not_found");
  expect(typeof res.body.error.message).toBe("string");
});

test("a controller's own envelope is passed through, not re-wrapped", async () => {
  // The filter must not rewrite a code a controller deliberately chose.
  const res = await authGet("/badnet/paths");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_network");
});
