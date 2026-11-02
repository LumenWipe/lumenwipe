import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppModule } from "@/app.module";
import { JsonLogger } from "@/common/json-logger";
import {
  RPC_SERVER_FACTORY,
  TRANSACTION_SUBMITTER,
  submitterFor,
  type TransactionSubmitterPort,
} from "@/common/ports";
import { configureApp } from "@/configure-app";
import { TxPendingError } from "@/lib/utils/errors";

const KEY = "e2e_test_key";
const SOURCE = Keypair.random();
const HASH = "ab".repeat(32);
const WINDOW = {
  oldestLedger: 100,
  oldestLedgerCloseTime: 1000,
  latestLedger: 200,
  latestLedgerCloseTime: 2000,
};

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
let getTransaction: () => Promise<unknown>;
let sendTransaction: () => Promise<unknown>;
let getLedgerEntries: () => Promise<unknown>;
let submitOverride: TransactionSubmitterPort["submitAndWait"] | null = null;
let sends = 0;
let rpcReads = 0;

const server = {
  getTransaction: () => {
    rpcReads++;
    return getTransaction();
  },
  sendTransaction: () => {
    sends++;
    return sendTransaction();
  },
  getLedgerEntries: () => getLedgerEntries(),
};

const authGet = (path: string) => request(http).get(path).set("Authorization", `Bearer ${KEY}`);
const authPost = (path: string) => request(http).post(path).set("Authorization", `Bearer ${KEY}`);

function signedXdr(): string {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx.toXDR();
}

beforeAll(async () => {
  process.env.API_KEYS = `test=${KEY}`;
  const real = submitterFor(() => server as never);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RPC_SERVER_FACTORY)
    .useValue(() => server)
    .overrideProvider(TRANSACTION_SUBMITTER)
    .useValue({
      submitAndWait: (signed: string, network: "testnet" | "mainnet") =>
        (submitOverride ?? real.submitAndWait)(signed, network),
    })
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app, new JsonLogger(() => undefined));
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  submitOverride = null;
  sends = 0;
  rpcReads = 0;
  getTransaction = async () => ({ status: "NOT_FOUND", ...WINDOW });
  sendTransaction = async () => ({ status: "PENDING" });
  getLedgerEntries = async () => ({ entries: [] });
});

describe("submit", () => {
  test("the same confirmed envelope twice answers 200 with an identical body", async () => {
    getTransaction = async () => ({ status: "SUCCESS", ledger: 42 });
    const signed = signedXdr();
    const first = await authPost("/v1/testnet/submit").send({ signedXdr: signed });
    const second = await authPost("/v1/testnet/submit").send({ signedXdr: signed });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body.status).toBe("success");
    expect(sends).toBe(0);
  });

  test("a confirmation timeout is resolved by the lookup with nothing submitted again", async () => {
    submitOverride = async () => {
      throw new TxPendingError(HASH);
    };
    const pending = await authPost("/v1/testnet/submit").send({ signedXdr: signedXdr() });
    expect(pending.status).toBe(504);
    expect(pending.body.error.code).toBe("confirmation_timeout");
    expect(pending.body.error.details).toEqual({ status: "pending", hash: HASH });

    getTransaction = async () => ({ status: "SUCCESS", ledger: 9 });
    const looked = await authGet(`/v1/testnet/transactions/${pending.body.error.details.hash}`);
    expect(looked.status).toBe(200);
    expect(looked.body).toEqual({ status: "confirmed", hash: HASH, ledger: 9 });
    expect(sends).toBe(0);
  });

  test("a deterministic rejection is 422 submit_rejected with its result code", async () => {
    sendTransaction = async () => ({
      status: "ERROR",
      errorResult: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txInsufficientBalance(),
        ext: xdr.TransactionResultExt.v0(),
      }),
    });
    const res = await authPost("/v1/testnet/submit").send({ signedXdr: signedXdr() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("submit_rejected");
    expect(res.body.error.details.resultCode).toBe("tx_insufficient_balance");
  });

  test("an upstream fault stays 502 submit_failed", async () => {
    getTransaction = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443");
    };
    const res = await authPost("/v1/testnet/submit").send({ signedXdr: signedXdr() });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("submit_failed");
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    expect(sends).toBe(0);
  });
});

describe("GET transactions/:hash", () => {
  test("a malformed hash is refused before any upstream call", async () => {
    for (const bad of ["abc", "g".repeat(64), "a".repeat(65)]) {
      const res = await authGet(`/v1/testnet/transactions/${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_tx_hash");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(rpcReads).toBe(0);
  });

  test("requires a key", async () => {
    const res = await request(http).get(`/v1/testnet/transactions/${HASH}`);
    expect(res.status).toBe(401);
    expect(rpcReads).toBe(0);
  });

  test("an uppercase hash is normalized", async () => {
    const res = await authGet(`/v1/testnet/transactions/${HASH.toUpperCase()}`);
    expect(res.body.hash).toBe(HASH);
  });

  test("not_found states the window it searched", async () => {
    const res = await authGet(`/v1/testnet/transactions/${HASH}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "not_found", hash: HASH, searched: WINDOW });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a failed transaction carries its reason and code", async () => {
    getTransaction = async () => ({
      status: "FAILED",
      ledger: 8,
      resultXdr: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txBadAuth(),
        ext: xdr.TransactionResultExt.v0(),
      }),
    });
    const res = await authGet(`/v1/testnet/transactions/${HASH}`);
    expect(res.body).toMatchObject({
      status: "failed",
      hash: HASH,
      ledger: 8,
      resultCode: "tx_bad_auth",
    });
  });

  test("an RPC outage is a 503 with Retry-After and no internal detail", async () => {
    getTransaction = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443");
    };
    const res = await authGet(`/v1/testnet/transactions/${HASH}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("service_unavailable");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });
});

describe("GET close/status", () => {
  const source = SOURCE.publicKey();
  const accountEntry = (numSubEntries: number) => ({
    entries: [{ val: { type: "account", account: { numSubEntries, ext: { type: "v0" } } } }],
  });

  test("an account with sub-entries is open, with its remaining work", async () => {
    getLedgerEntries = async () => accountEntry(3);
    const res = await authGet(`/v1/testnet/close/status?source=${source}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source,
      phase: "open",
      remaining: { subentries: 3, sponsoring: 0, sponsored: 0 },
    });
  });

  test("an account with nothing left is ready to merge", async () => {
    getLedgerEntries = async () => accountEntry(0);
    const res = await authGet(`/v1/testnet/close/status?source=${source}`);
    expect(res.body.phase).toBe("ready_to_merge");
  });

  test("an invalid source is refused", async () => {
    const res = await authGet("/v1/testnet/close/status?source=nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_source");
  });

  test("a failed read is a 503, never a phase", async () => {
    getLedgerEntries = async () => {
      throw new Error("rpc down");
    };
    const res = await authGet(`/v1/testnet/close/status?source=${source}`);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
