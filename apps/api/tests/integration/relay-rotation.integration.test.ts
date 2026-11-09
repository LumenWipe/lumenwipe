import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { Subprocess } from "bun";
import { buildMediatorMergePaymentTx } from "@/lib/stellar/tx-builder/merge";
import {
  sourcedFinding,
  transactionsInWindow,
  type HorizonTransactionPage,
  type ServiceAccount,
} from "@/lib/monitors/service-accounts";

// The relay account rotation of docs/runbooks/rotate-relay-account.mdx, on testnet, against the
// real API started as a child process: once with a relay account generated here, then again with
// a second one, as a new revision would be. Every key is generated at run time, the child gets
// only the environment built below and a scratch working directory, so no .env.local, real relay
// secret or mainnet setting can reach it. Funded tier, like the other tests that use friendbot.
const RUN_INTEGRATION =
  !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.LUMENWIPE_INTEGRATION_FUNDED;

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
// The child runs outside apps/api, so it names the tsconfig that turns on Nest's decorators.
const TSCONFIG = new URL("../../tsconfig.json", import.meta.url).pathname;
// The base reserve: what the runbook funds a relay account with, and all it ever holds.
const RELAY_FUNDING_XLM = "1";
const API_BOOT_TIMEOUT_MS = 30_000;
// The public endpoints CI uses, fixed here so a keyed URL from a developer's environment never
// reaches the child.
const TESTNET_RPC =
  "https://soroban-rpc.testnet.stellar.gateway.fm,https://soroban-testnet.stellar.org";

const workDir = mkdtempSync(join(tmpdir(), "relay-rotation-"));
const children: Subprocess[] = [];

afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  rmSync(workDir, { recursive: true, force: true });
});

interface RunningApi {
  url: string;
  apiKey: string;
  stop: () => Promise<void>;
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

async function startApi(relay: Keypair): Promise<RunningApi> {
  const port = freePort();
  const log = join(workDir, `api-${port}.log`);
  const apiKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const child = Bun.spawn([process.execPath, `--tsconfig-override=${TSCONFIG}`, MAIN], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH ?? "",
      PORT: String(port),
      API_KEYS: `rotation-test=${apiKey}`,
      STELLAR_RPC_TESTNET: TESTNET_RPC,
      PATH_ROUTING_API_TESTNET: HORIZON_URL,
      MEDIATOR_PUBLIC_TESTNET: relay.publicKey(),
      MEDIATOR_SECRET_TESTNET: relay.secret(),
    },
    stdout: "ignore",
    stderr: Bun.file(log),
  });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + API_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the API exited at boot: ${await Bun.file(log).text()}`);
    }
    const up = await fetch(`${url}/health`).then(
      (res) => res.ok,
      () => false
    );
    if (up) {
      return {
        url,
        apiKey,
        stop: async () => {
          child.kill();
          await child.exited;
        },
      };
    }
    await Bun.sleep(250);
  }
  throw new Error("the API did not answer /health in time");
}

async function cosign(api: RunningApi, xdr: string): Promise<Response> {
  return fetch(`${api.url}/v1/testnet/mediator/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${api.apiKey}` },
    body: JSON.stringify({ transaction: xdr }),
  });
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

async function nativeBalance(server: Horizon.Server, id: string): Promise<string> {
  const account = await server.loadAccount(id);
  const native = account.balances.find((b) => b.asset_type === "native");
  if (!native) throw new Error(`${id} has no native balance`);
  return native.balance;
}

async function exists(server: Horizon.Server, id: string): Promise<boolean> {
  return server.loadAccount(id).then(
    () => true,
    () => false
  );
}

/** The close transaction the API builds for an exchange destination, signed by the user. */
async function userSignedClose(
  server: Horizon.Server,
  source: Keypair,
  relay: string,
  destination: string
): Promise<string> {
  const account = await server.loadAccount(source.publicKey());
  const xdr = buildMediatorMergePaymentTx(
    new Account(source.publicKey(), account.sequence),
    relay,
    destination,
    await nativeBalance(server, source.publicKey()),
    "rotation-test",
    "testnet",
    "text"
  );
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(source);
  return tx.toXDR();
}

function submit(server: Horizon.Server, xdr: string) {
  return server.submitTransaction(TransactionBuilder.fromXDR(xdr, Networks.TESTNET));
}

function resultCodes(err: unknown): unknown {
  return (err as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
    ?.extras?.result_codes;
}

test.skipIf(!RUN_INTEGRATION)(
  "a close lands through the new relay account after a rotation, and one built for the old account fails safely",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const operator = Keypair.random();
    const exchange = Keypair.random();
    const late = Keypair.random();
    const inFlight = Keypair.random();
    const oldRelay = Keypair.random();
    const newRelay = Keypair.random();
    const started = new Date();

    await Promise.all([operator, exchange, late, inFlight].map((k) => fund(k.publicKey())));
    const funding = new TransactionBuilder(await server.loadAccount(operator.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.createAccount({
          destination: oldRelay.publicKey(),
          startingBalance: RELAY_FUNDING_XLM,
        })
      )
      .addOperation(
        Operation.createAccount({
          destination: newRelay.publicKey(),
          startingBalance: RELAY_FUNDING_XLM,
        })
      )
      .setTimeout(60)
      .build();
    funding.sign(operator);
    await server.submitTransaction(funding);

    // Before the rotation: two closes are built against the old relay account and co-signed.
    const before = await startApi(oldRelay);
    const lateUnsigned = await userSignedClose(
      server,
      late,
      oldRelay.publicKey(),
      exchange.publicKey()
    );
    const lateRes = await cosign(before, lateUnsigned);
    expect(lateRes.status).toBe(200);
    const lateSigned = ((await lateRes.json()) as { transaction: string }).transaction;
    const inFlightRes = await cosign(
      before,
      await userSignedClose(server, inFlight, oldRelay.publicKey(), exchange.publicKey())
    );
    expect(inFlightRes.status).toBe(200);
    const inFlightSigned = ((await inFlightRes.json()) as { transaction: string }).transaction;
    await before.stop();

    // The rotation: a new process with the new relay account, as a new revision.
    const after = await startApi(newRelay);

    // A close built for the old account is refused, so the client rebuilds it.
    const refused = await cosign(after, lateUnsigned);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "transaction_structure_not_allowed"
    );

    // One co-signed before the rotation still lands while the old account exists.
    await submit(server, inFlightSigned);
    expect(await exists(server, inFlight.publicKey())).toBe(false);

    // The drain: the operator sources the transaction and the old key signs only the merge, so
    // the retired address never sources a transaction and its monitor stays quiet.
    const drain = new TransactionBuilder(await server.loadAccount(operator.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.accountMerge({
          source: oldRelay.publicKey(),
          destination: operator.publicKey(),
        })
      )
      .setTimeout(60)
      .build();
    drain.sign(operator, oldRelay);
    await server.submitTransaction(drain);
    expect(await exists(server, oldRelay.publicKey())).toBe(false);

    const retired: ServiceAccount = {
      role: "mediator",
      network: "testnet",
      address: oldRelay.publicKey(),
      floorXlm: "1",
      retired: true,
    };
    const history = await transactionsInWindow(
      async (path) =>
        (await (await fetch(`${HORIZON_URL}${path}`)).json()) as HorizonTransactionPage,
      retired.address,
      started
    );
    expect(history.transactions.length).toBeGreaterThanOrEqual(3);
    expect(history.transactions.map((tx) => sourcedFinding(retired, tx))).not.toContain(
      expect.anything()
    );

    // A close co-signed before the rotation and submitted after the drain fails as a whole.
    const stale = await submit(server, lateSigned).then(
      () => null,
      (err: unknown) => err
    );
    // The merge finds no destination and the forward no source, so nothing moves.
    expect(resultCodes(stale)).toEqual({
      transaction: "tx_failed",
      operations: ["op_no_account", "op_no_source_account"],
    });
    expect(await exists(server, late.publicKey())).toBe(true);

    // Rebuilt against the new relay account, the same close lands.
    const rebuilt = await cosign(
      after,
      await userSignedClose(server, late, newRelay.publicKey(), exchange.publicKey())
    );
    expect(rebuilt.status).toBe(200);
    const result = await submit(
      server,
      ((await rebuilt.json()) as { transaction: string }).transaction
    );
    expect(result.successful).toBe(true);
    expect(await exists(server, late.publicKey())).toBe(false);
    expect(await nativeBalance(server, newRelay.publicKey())).toBe("1.0000000");
    await after.stop();
  },
  180_000
);
