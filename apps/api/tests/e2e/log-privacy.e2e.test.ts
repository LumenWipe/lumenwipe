import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  Account,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import * as accountPlan from "@/lib/close-api/account-plan";
import * as readAccount from "@/lib/close-api/read-account";
import { servedRegistry } from "@/lib/exchange-registry";
import * as submitModule from "@/lib/stellar/submit";

const KEY = "e2e_test_key";
const PLACEHOLDER_SECRET = `S${"A".repeat(55)}`;
const MEMO = "4815162342";
const EXCHANGE = servedRegistry().entries.find((e) => e.requiresMediator && e.requiresMemo)!;
const SOURCE = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const SIGNED_XDR = (() => {
  const signer = Keypair.random();
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: EXCHANGE.address }))
    .addMemo(Memo.id(MEMO))
    .setTimeout(30)
    .build();
  tx.sign(signer);
  return tx.toXDR();
})();

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
const written: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  http = app.getHttpServer();
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  spyOn(accountPlan, "buildAccountPlan").mockRestore();
  spyOn(readAccount, "readAccountState").mockRestore();
  spyOn(submitModule, "submitAndWait").mockRestore();
});

afterAll(async () => {
  process.stdout.write = realWrite;
  await app.close();
});

const post = (path: string, ip: string) =>
  request(http).post(path).set("Authorization", `Bearer ${KEY}`).set("X-Forwarded-For", ip);

test("an exchange close that fails at every step logs no address, memo, secret or body", async () => {
  const leak = `${SOURCE} -> ${EXCHANGE.address} memo ${MEMO} key ${PLACEHOLDER_SECRET} ${SIGNED_XDR}`;
  spyOn(accountPlan, "buildAccountPlan").mockRejectedValue(new Error(leak));
  spyOn(readAccount, "readAccountState").mockRejectedValue(new Error(leak));
  spyOn(submitModule, "submitAndWait").mockRejectedValue(new Error(leak));

  const plan = await post("/v1/testnet/close/plan", "203.0.113.20").send({
    source: SOURCE,
    destination: EXCHANGE.address,
    memo: MEMO,
  });
  const transactions = await post("/v1/testnet/close/transactions", "203.0.113.21").send({
    source: SOURCE,
    destination: EXCHANGE.address,
    memo: MEMO,
  });
  const submit = await post("/v1/testnet/submit", "203.0.113.22").send({ signedXdr: SIGNED_XDR });
  expect([plan.status, transactions.status, submit.status]).toEqual([500, 500, 502]);
  for (const res of [plan, transactions, submit]) {
    expect(JSON.stringify(res.body)).not.toContain(EXCHANGE.address);
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  }

  const lines = written.join("").split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const text = lines.join("\n");

  expect(records.some((r) => r.severity === "ERROR")).toBe(true);
  expect(text).toContain("[exchange]");
  expect(text).toContain("[memo]");
  expect(text).toContain(`${SOURCE.slice(0, 4)}...${SOURCE.slice(-4)}~`);

  expect(text).not.toMatch(/[GCM][A-Z2-7]{55}/);
  expect(text).not.toMatch(/S[A-Z2-7]{55}/);
  expect(text).not.toContain(EXCHANGE.address.slice(0, 8));
  expect(text).not.toContain(EXCHANGE.address.slice(-8));
  expect(text).not.toContain(`${EXCHANGE.address.slice(0, 4)}...${EXCHANGE.address.slice(-4)}`);
  expect(text).not.toContain(MEMO);
  expect(text).not.toContain(SIGNED_XDR);
  expect(text).not.toContain(OTHER);
});

test("access lines name the route pattern and never the raw path", async () => {
  written.length = 0;
  await request(http)
    .get(`/testnet/account/${OTHER}`)
    .set("Authorization", `Bearer ${KEY}`)
    .set("X-Forwarded-For", "203.0.113.23");
  const access = written
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((r) => r.message === "request");
  expect(access).toMatchObject({
    route: "/:network/account/:address",
    keyLabel: "test",
    network: "testnet",
  });
  expect(JSON.stringify(access)).not.toContain(OTHER);
  expect(typeof access?.latencyMs).toBe("number");
  expect(access).not.toHaveProperty("ip");
});
