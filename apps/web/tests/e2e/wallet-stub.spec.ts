import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { installWalletStub, USER_REJECTED } from "./helpers/wallet-stub";

// Every option of the shared wallet stub, exercised through the real @stellar/freighter-api the
// wallet kit bundles, on a blank page of its own origin. No app, no API and no network: the live
// specs (plain-language-errors.spec.ts) cover what the app does with each answer.

const ORIGIN = "http://wallet-stub.test";

// The exact freighter-api build the kit resolves, so the protocol under test is the shipped one.
const kitDir = realpathSync(join(__dirname, "../../node_modules/@creit-tech/stellar-wallets-kit"));
const FREIGHTER_API = createRequire(join(kitDir, "package.json")).resolve("@stellar/freighter-api");

type Reply = Record<string, unknown>;

async function openBlankPage(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub</title>" })
  );
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: FREIGHTER_API });
}

/** Calls one freighter-api function in the page, as the kit's Freighter module does. */
function call(page: Page, name: string, ...args: unknown[]): Promise<Reply> {
  return page.evaluate(
    ([fn, rest]) =>
      (
        window as unknown as { freighterApi: Record<string, (...a: unknown[]) => Promise<Reply>> }
      ).freighterApi[fn as string](...(rest as unknown[])),
    [name, args] as const
  );
}

function unsignedTx(source: Keypair): Transaction {
  return new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(60)
    .build();
}

function signTx(page: Page, tx: Transaction, address: string): Promise<Reply> {
  return call(page, "signTransaction", tx.toXdr(), {
    networkPassphrase: Networks.TESTNET,
    address,
    accountToSign: address,
  });
}

/** The signatures on a signed envelope that verify against `key` over the transaction's hash. */
function signaturesBy(signedXdr: string, key: Keypair): number {
  const signed = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET) as Transaction;
  return signed.signatures.filter(
    (s) =>
      Buffer.from(s.hint.toBytes()).equals(key.signatureHint()) &&
      key.verify(signed.hash(), Buffer.from(s.signature.toBytes()))
  ).length;
}

test("reports the scripted address and testnet by default", async ({ page }) => {
  const account = Keypair.random();
  await installWalletStub(page, { address: account.publicKey() });
  await openBlankPage(page);

  expect(await call(page, "isConnected")).toEqual({ isConnected: true });
  expect(await call(page, "getAddress")).toEqual({ address: account.publicKey() });
  expect(await call(page, "getNetwork")).toEqual({
    network: "TESTNET",
    networkPassphrase: Networks.TESTNET,
  });
});

test("reports the public network when scripted to", async ({ page }) => {
  await installWalletStub(page, { address: Keypair.random().publicKey(), network: "PUBLIC" });
  await openBlankPage(page);

  expect(await call(page, "getNetwork")).toEqual({
    network: "PUBLIC",
    networkPassphrase: Networks.PUBLIC,
  });
});

test("answers a network request with the scripted error", async ({ page }) => {
  const error = { code: -3, message: "This network is not supported." };
  await installWalletStub(page, { address: Keypair.random().publicKey(), network: { error } });
  await openBlankPage(page);

  expect(await call(page, "getNetwork")).toEqual({ network: "", networkPassphrase: "", error });
});

test("approve signs the requested transaction with the test keypair", async ({ page }) => {
  const account = Keypair.random();
  const wallet = await installWalletStub(page, {
    address: account.publicKey(),
    sign: { kind: "approve", keypair: account },
  });
  await openBlankPage(page);
  const tx = unsignedTx(account);

  const reply = await signTx(page, tx, account.publicKey());

  expect(reply.signerAddress).toBe(account.publicKey());
  expect(signaturesBy(reply.signedTxXdr as string, account)).toBe(1);
  expect(wallet.signRequests).toEqual([
    {
      type: "SUBMIT_TRANSACTION",
      transactionXdr: tx.toXdr(),
      networkPassphrase: Networks.TESTNET,
      accountToSign: account.publicKey(),
    },
  ]);
});

test("approve with another keypair answers as a different signing account", async ({ page }) => {
  const account = Keypair.random();
  const other = Keypair.random();
  await installWalletStub(page, {
    address: account.publicKey(),
    sign: { kind: "approve", keypair: other },
  });
  await openBlankPage(page);

  const reply = await signTx(page, unsignedTx(account), account.publicKey());

  expect(reply.signerAddress).toBe(other.publicKey());
  expect(signaturesBy(reply.signedTxXdr as string, other)).toBe(1);
  expect(signaturesBy(reply.signedTxXdr as string, account)).toBe(0);
});

test("reject answers with the default user rejection or a given wallet error", async ({ page }) => {
  const account = Keypair.random();
  const wallet = await installWalletStub(page, { address: account.publicKey() });
  await openBlankPage(page);

  expect(await signTx(page, unsignedTx(account), account.publicKey())).toEqual({
    signedTxXdr: "",
    signerAddress: "",
    error: USER_REJECTED,
  });

  const error = { code: -1, message: "The wallet encountered an internal error." };
  wallet.set({ sign: { kind: "reject", ...error } });
  expect(await signTx(page, unsignedTx(account), account.publicKey())).toEqual({
    signedTxXdr: "",
    signerAddress: "",
    error,
  });
});

test("never leaves a signing request unanswered", async ({ page }) => {
  const account = Keypair.random();
  const wallet = await installWalletStub(page, {
    address: account.publicKey(),
    sign: { kind: "never" },
  });
  await openBlankPage(page);

  const settled = await page.evaluate(
    ([xdr, address, networkPassphrase]) => {
      const api = (
        window as unknown as {
          freighterApi: { signTransaction: (x: string, o: object) => Promise<unknown> };
        }
      ).freighterApi;
      const pending = api.signTransaction(xdr, {
        networkPassphrase,
        address,
        accountToSign: address,
      });
      return Promise.race([
        pending.then(() => "answered"),
        new Promise((resolve) => setTimeout(() => resolve("unanswered"), 2_000)),
      ]);
    },
    [unsignedTx(account).toXdr(), account.publicKey(), Networks.TESTNET] as const
  );

  expect(settled).toBe("unanswered");
  expect((await wallet.waitForSignRequest(1_000)).accountToSign).toBe(account.publicKey());
});

test("delayMs holds the signing answer back", async ({ page }) => {
  const account = Keypair.random();
  await installWalletStub(page, {
    address: account.publicKey(),
    sign: { kind: "reject", delayMs: 1_500 },
  });
  await openBlankPage(page);

  const started = Date.now();
  const reply = await signTx(page, unsignedTx(account), account.publicKey());

  expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
  expect(reply.error).toEqual(USER_REJECTED);
});

test("set() changes the wallet mid-test, and the change survives a navigation", async ({
  page,
}) => {
  const first = Keypair.random();
  const second = Keypair.random();
  const wallet = await installWalletStub(page, { address: first.publicKey() });
  await openBlankPage(page);
  expect(await call(page, "getAddress")).toEqual({ address: first.publicKey() });

  wallet.set({ address: second.publicKey(), network: "PUBLIC" });
  expect(await call(page, "getAddress")).toEqual({ address: second.publicKey() });

  await page.reload();
  await page.addScriptTag({ path: FREIGHTER_API });
  expect(await call(page, "getAddress")).toEqual({ address: second.publicKey() });
  expect(await call(page, "getNetwork")).toMatchObject({ network: "PUBLIC" });
  expect(wallet.requests.map((r) => r.type)).toEqual([
    "REQUEST_PUBLIC_KEY",
    "REQUEST_PUBLIC_KEY",
    "REQUEST_PUBLIC_KEY",
    "REQUEST_NETWORK_DETAILS",
  ]);
});
