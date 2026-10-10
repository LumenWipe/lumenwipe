import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Keypair, Networks, TransactionBuilder, Account, Operation } from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { configureApp, JSON_BODY_LIMIT } from "@/configure-app";

const KEY = "e2e_test_key";

const POST_ROUTES = [
  "/v1/:network/close/plan",
  "/v1/:network/close/batch-plan",
  "/v1/:network/close/transactions",
  "/v1/:network/submit",
  "/v1/:network/stats/merges",
  "/:network/mediator/sign",
  "/:network/fee-bump/sponsor",
  "/:network/allowances/revoke",
  "/integrator/auth/challenge",
  "/integrator/auth/session",
  "/integrator/keys",
  "/integrator/keys/:id/revoke",
  "/integrator/keys/:id/rotate",
  "/admin/api-keys",
  "/admin/api-keys/:id/revoke",
  "/admin/api-keys/:id/rotate",
];

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

const concrete = (route: string): string =>
  route.replace(":network", "testnet").replace(":id", "x");
const post = (route: string) =>
  request(http).post(concrete(route)).set("Authorization", `Bearer ${KEY}`);

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

test("the matrix covers every POST route the app registers", () => {
  const router = (app.getHttpAdapter().getInstance() as { router: { stack: unknown[] } }).router;
  const registered = (
    router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
  )
    .filter((layer) => layer.route?.methods.post)
    .map((layer) => layer.route!.path)
    .sort();
  expect(registered).toEqual([...POST_ROUTES].sort());
});

describe.each(POST_ROUTES)("POST %s", (route) => {
  const expectEnvelope = (res: request.Response, status: number, code: string): void => {
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.message).toBe("string");
  };

  test("a text/plain body is 415", async () => {
    const res = await post(route).set("Content-Type", "text/plain").send("hello");
    expectEnvelope(res, 415, "unsupported_media_type");
  });

  test.each([
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("%s is 400 invalid_body", async (_label, raw) => {
    const res = await post(route).set("Content-Type", "application/json").send(raw);
    expectEnvelope(res, 400, "invalid_body");
  });

  test("a body over the limit is 413", async () => {
    const res = await post(route)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ pad: "a".repeat(200 * 1024) }));
    expectEnvelope(res, 413, "payload_too_large");
  });

  test("no body is never a 500 and logs no stack", async () => {
    const spy = spyOn(Logger.prototype, "error");
    const res = await post(route);
    expect(res.body.error.code).toBeString();
    expect(res.body.error.code).not.toBe("internal_error");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

test.each(["/integrator/keys/x/revoke", "/integrator/keys/x/rotate"])(
  "POST %s with no body and no content type is not rejected as a bad body",
  async (path) => {
    const res = await request(http).post(path).set("Authorization", `Bearer ${KEY}`);
    expect(res.status).not.toBe(415);
    expect(res.body.error.code).not.toBe("invalid_body");
    expect(res.body.error.code).not.toBe("internal_error");
  }
);

test("a corrupt compressed body is a 400, not a server fault", async () => {
  const res = await post("/v1/:network/close/plan")
    .set("Content-Type", "application/json")
    .set("Content-Encoding", "gzip")
    .send("not gzip");
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("invalid_body");
});

test("an unsupported content encoding is 415", async () => {
  const res = await post("/v1/:network/close/plan")
    .set("Content-Type", "application/json")
    .set("Content-Encoding", "foo")
    .send("{}");
  expect(res.status).toBe(415);
  expect(res.body.error.code).toBe("unsupported_media_type");
});

test("an unsupported charset is 415", async () => {
  const res = await post("/v1/:network/close/plan")
    .set("Content-Type", "application/json; charset=latin1")
    .send("{}");
  expect(res.status).toBe(415);
  expect(res.body.error.code).toBe("unsupported_media_type");
});

describe("the legitimate largest bodies fit the limit", () => {
  const limit = 100 * 1024;
  expect(JSON_BODY_LIMIT).toBe("100kb");

  test("submit with a 100-operation signed envelope", () => {
    const source = Keypair.random();
    const builder = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    }).setTimeout(30);
    for (let i = 0; i < 100; i++) {
      builder.addOperation(
        Operation.manageData({ name: "n".repeat(64), value: Buffer.alloc(64, i) })
      );
    }
    const tx = builder.build();
    tx.sign(source);
    const body = JSON.stringify({ signedXdr: tx.toXDR() });
    expect(body.length).toBeLessThan(limit / 2);
  });

  test("batch-plan at its address cap", async () => {
    const { BATCH_PLAN_MAX_ADDRESSES } = await import("@/lib/close-api/batch-plan");
    const addresses = Array.from({ length: BATCH_PLAN_MAX_ADDRESSES }, () =>
      Keypair.random().publicKey()
    );
    const body = JSON.stringify({ addresses, destination: Keypair.random().publicKey() });
    expect(body.length).toBeLessThan(limit / 10);
  });

  test("close/transactions with 100 fully-parameterised decisions", () => {
    const decisions = Array.from({ length: 100 }, () => ({
      id: `asset:USDC-${Keypair.random().publicKey()}`,
      choice: "transfer_to_account",
      params: {
        maxSlippageBps: 100,
        minAmountOut: "123456789012",
        provider: "soroswap",
        destination: Keypair.random().publicKey(),
      },
    }));
    const body = JSON.stringify({
      source: Keypair.random().publicKey(),
      destination: Keypair.random().publicKey(),
      memo: "1234567890",
      decisions,
    });
    expect(body.length).toBeLessThan(limit / 2);
  });
});
