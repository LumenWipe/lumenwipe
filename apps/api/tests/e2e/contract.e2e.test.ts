import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { JsonLogger } from "@/common/json-logger";
import { configureApp } from "@/configure-app";
import { API_VERSION } from "@/openapi";

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
  configureApp(app, new JsonLogger(() => undefined));
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

test("the service index at / is public and points at the docs", async () => {
  const res = await request(http).get("/");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    name: "LumenWipe API",
    version: API_VERSION,
    docs: "/docs",
    openapi: "/docs-json",
    health: "/health",
  });
});

test("an authenticated route without a key is rejected 401", async () => {
  const res = await request(http).get("/testnet/account/NOPE");
  expect(res.status).toBe(401);
  expect(res.body).toMatchObject({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
});

test("an authenticated route with an unknown key is rejected 401", async () => {
  const res = await request(http).get("/testnet/account/NOPE").set("Authorization", "Bearer nope");
  expect(res.status).toBe(401);
  expect(res.body).toMatchObject({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
});

// ─── Error contracts (with a valid key) ──────────────────────────────────────

test("close/plan rejects an invalid network with the v1 error shape", async () => {
  const res = await authPost("/v1/badnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    error: { code: "invalid_network", message: "Invalid network." },
  });
});

test("close/plan rejects a missing source", async () => {
  const res = await authPost("/v1/testnet/close/plan").send({});
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    error: { code: "invalid_source", message: "A valid source account (G...) is required." },
  });
});

test("close/batch-plan rejects an invalid network with the v1 error shape", async () => {
  const res = await authPost("/v1/badnet/close/batch-plan").send({ addresses: [] });
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    error: { code: "invalid_network", message: "Invalid network." },
  });
});

test("close/batch-plan rejects an empty addresses array", async () => {
  const res = await authPost("/v1/testnet/close/batch-plan").send({ addresses: [] });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_addresses");
});

test("close/batch-plan rejects a missing addresses field", async () => {
  const res = await authPost("/v1/testnet/close/batch-plan").send({});
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_addresses");
});

test("close/batch-plan rejects an invalid address inside the array", async () => {
  const res = await authPost("/v1/testnet/close/batch-plan").send({
    addresses: [Keypair.random().publicKey(), "NOPE"],
  });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_addresses");
});

test("close/batch-plan rejects more addresses than the batch cap", async () => {
  const addresses = Array.from({ length: 21 }, () => Keypair.random().publicKey());
  const res = await authPost("/v1/testnet/close/batch-plan").send({ addresses });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("too_many_addresses");
});

test("close/batch-plan rejects an invalid destination", async () => {
  const res = await authPost("/v1/testnet/close/batch-plan").send({
    addresses: [Keypair.random().publicKey()],
    destination: "NOPE",
  });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_destination");
});

test("submit rejects a missing signedXdr", async () => {
  const res = await authPost("/v1/testnet/submit").send({});
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
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
  expect(res.body).toMatchObject({
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

test("fee-bump/sponsor is unavailable with no fee account secret configured, rather than 404", async () => {
  // Force the unconfigured state explicitly instead of assuming the ambient environment has no
  // fee account secret - a dev's own .env.local (needed for local full-flow testing per
  // CLAUDE.md) sets a real one, which silently made this test assert the wrong thing (a parsed
  // secret means getFeeAccountKeypair returns non-null, so the request falls through past the
  // 503 branch to the transaction body's own 400 on malformed XDR - still a failure, just not
  // the one this test claims to check).
  const original = process.env.FEE_ACCOUNT_SECRET_TESTNET;
  delete process.env.FEE_ACCOUNT_SECRET_TESTNET;
  try {
    const res = await authPost("/testnet/fee-bump/sponsor").send({ transaction: "AAAA" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("fee_bump_not_configured");
  } finally {
    if (original === undefined) delete process.env.FEE_ACCOUNT_SECRET_TESTNET;
    else process.env.FEE_ACCOUNT_SECRET_TESTNET = original;
  }
});

test("malformed JSON on fee-bump/sponsor returns the same error contract as every other route", async () => {
  const res = await authPost("/testnet/fee-bump/sponsor")
    .set("Content-Type", "application/json")
    .send("{ not json");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_body");
});

// ─── Admin: self-serve API key management (#289) ─────────────────────────────
// Unauthenticated on purpose: admin/api-keys is @Public() + AdminGuard, a distinct operator
// secret from the api-key bearer used everywhere else in this file.

/** Sets ADMIN_API_TOKEN + FIRESTORE_PROJECT_ID for the duration of `fn`, then restores them.
 *  The store behind these routes was already fixed as in-memory at app boot (beforeAll runs
 *  with neither var set), so "configuring" here only flips AdminGuard's own checks - the
 *  in-memory store used underneath means no test ever touches live Firestore. */
async function withAdminConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const originalToken = process.env.ADMIN_API_TOKEN;
  const originalProject = process.env.FIRESTORE_PROJECT_ID;
  process.env.ADMIN_API_TOKEN = "admin_test_token";
  process.env.FIRESTORE_PROJECT_ID = "test-project";
  try {
    return await fn();
  } finally {
    if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = originalToken;
    if (originalProject === undefined) delete process.env.FIRESTORE_PROJECT_ID;
    else process.env.FIRESTORE_PROJECT_ID = originalProject;
  }
}

const adminPost = (path: string) =>
  request(http).post(path).set("Authorization", "Bearer admin_test_token");
const adminGet = (path: string) =>
  request(http).get(path).set("Authorization", "Bearer admin_test_token");

test("admin/api-keys is unavailable with no admin token or Firestore project configured", async () => {
  const res = await request(http)
    .post("/admin/api-keys")
    .set("Authorization", "Bearer whatever")
    .send({ owner: "polar" });
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe("admin_api_not_configured");
});

test("admin/api-keys rejects a wrong admin token once configured", async () =>
  withAdminConfigured(async () => {
    const res = await request(http)
      .post("/admin/api-keys")
      .set("Authorization", "Bearer wrong-token")
      .send({ owner: "polar" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  }));

test("admin/api-keys create rejects an empty owner", async () =>
  withAdminConfigured(async () => {
    const res = await adminPost("/admin/api-keys").send({ owner: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_owner");
  }));

test("admin/api-keys create rejects a malformed rateLimit", async () =>
  withAdminConfigured(async () => {
    const res = await adminPost("/admin/api-keys").send({
      owner: "polar",
      rateLimit: { limit: -1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_rate_limit");
  }));

test("admin/api-keys list requires an owner query parameter", async () =>
  withAdminConfigured(async () => {
    const res = await adminGet("/admin/api-keys");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_owner");
  }));

test("admin/api-keys revoke and rotate 404 for an unknown id", async () =>
  withAdminConfigured(async () => {
    const revoke = await adminPost("/admin/api-keys/does-not-exist/revoke");
    expect(revoke.status).toBe(404);
    expect(revoke.body.error.code).toBe("api_key_not_found");

    const rotate = await adminPost("/admin/api-keys/does-not-exist/rotate");
    expect(rotate.status).toBe(404);
    expect(rotate.body.error.code).toBe("api_key_not_found");
  }));

test("admin/api-keys create/list/revoke/rotate work end-to-end", async () =>
  withAdminConfigured(async () => {
    const created = await adminPost("/admin/api-keys").send({ owner: "polar-e2e" });
    expect(created.status).toBe(201);
    expect(typeof created.body.key).toBe("string");
    expect(created.body.key).toStartWith("lw_");
    const keyId = created.body.record.id as string;
    expect(created.body.record.owner).toBe("polar-e2e");
    expect(created.body.record.revokedAt).toBeNull();

    // The new key authenticates a real route.
    const usesNewKey = await request(http)
      .post("/v1/testnet/close/plan")
      .set("Authorization", `Bearer ${created.body.key}`)
      .send({});
    expect(usesNewKey.status).toBe(400); // past auth, rejected on the missing `source` body field
    expect(usesNewKey.body.error.code).toBe("invalid_source");

    const listed = await adminGet("/admin/api-keys?owner=polar-e2e");
    expect(listed.status).toBe(200);
    expect(listed.body.keys.map((k: { id: string }) => k.id)).toContain(keyId);

    const rotated = await adminPost(`/admin/api-keys/${keyId}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.record.rotatedFrom).toBe(keyId);

    // The old key is dead now.
    const revokedNowRejects = await request(http)
      .post("/v1/testnet/close/plan")
      .set("Authorization", `Bearer ${created.body.key}`)
      .send({});
    expect(revokedNowRejects.status).toBe(401);

    const revoke = await adminPost(`/admin/api-keys/${rotated.body.record.id}/revoke`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe("revoked");
  }));

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
  expect(res.body).toMatchObject({
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

describe("malformed decision answers", () => {
  const malformed: [string, unknown][] = [
    ["null", null],
    ["an empty object", {}],
    ["a numeric id", { id: 1, choice: "x" }],
  ];

  for (const [name, element] of malformed) {
    test(`close/transactions answers ${name} next to a valid acknowledgement with 400 invalid_decisions`, async () => {
      const destination = Keypair.random().publicKey();
      const res = await authPost("/v1/testnet/close/transactions").send({
        source: Keypair.random().publicKey(),
        destination,
        decisions: [
          { id: `destination:${destination}`, choice: "i_control_this_address" },
          element,
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_decisions");
    });

    test(`close/plan answers ${name} with 400 invalid_decisions`, async () => {
      const res = await authPost("/v1/testnet/close/plan").send({
        source: Keypair.random().publicKey(),
        decisions: [element],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_decisions");
    });
  }

  test("both routes refuse an oversize array and an oversize string", async () => {
    const destination = Keypair.random().publicKey();
    const ack = { id: `destination:${destination}`, choice: "i_control_this_address" };
    for (const extra of [
      Array.from({ length: 1001 }, () => ({ id: "a", choice: "b" })),
      [{ id: "a".repeat(201), choice: "b" }],
    ]) {
      const decisions = [ack, ...extra];
      const plan = await authPost("/v1/testnet/close/plan").send({
        source: Keypair.random().publicKey(),
        decisions,
      });
      const tx = await authPost("/v1/testnet/close/transactions").send({
        source: Keypair.random().publicKey(),
        destination,
        decisions,
      });
      for (const res of [plan, tx]) {
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("invalid_decisions");
      }
    }
  });
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

// ─── Stats ───────────────────────────────────────────────────────────────────

test("stats totals are public and start at zero", async () => {
  const res = await request(http).get("/v1/testnet/stats");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ network: "testnet", accountsClosed: 0, xlmRecoveredStroops: "0" });
});

test("the stats feed is public and covers 365 days", async () => {
  const res = await request(http).get("/v1/mainnet/stats/feed");
  expect(res.status).toBe(200);
  expect(res.body.totals.network).toBe("mainnet");
  expect(res.body.recent).toEqual([]);
  expect(res.body.daily).toHaveLength(365);
});

test("stats reject an invalid network", async () => {
  const res = await request(http).get("/v1/badnet/stats");
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    error: { code: "invalid_network", message: "Invalid network." },
  });
});

test("recording a close requires an API key", async () => {
  const res = await request(http)
    .post("/v1/testnet/stats/merges")
    .send({ txHash: "a".repeat(64) });
  expect(res.status).toBe(401);
});

test("recording a close rejects a malformed hash", async () => {
  const res = await authPost("/v1/testnet/stats/merges").send({ txHash: "abc" });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_tx_hash");
});
