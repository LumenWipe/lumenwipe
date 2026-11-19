import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { LedgerModule } from "@creit-tech/stellar-wallets-kit/modules/ledger";
import { hardwareWalletPaths } from "@creit-tech/stellar-wallets-kit/state";
import {
  LEDGER_CLEAR_SIGNING_MAX_BYTES,
  LEDGER_WALLET_ID,
  WalletKitSigner,
  WalletNotUsableError,
  WalletSigningError,
} from "@/lib/stellar/signer";
import { LEDGER_ID } from "@/lib/wallet-kit/wallet-ids";
import {
  LEDGER_ACCOUNT_NOT_LOADED,
  LEDGER_BUSY,
  LEDGER_CANNOT_SHOW,
  LEDGER_DISCONNECTED,
  LEDGER_HASH_NEXT,
  LEDGER_HASH_SIGNING_OFF,
  LEDGER_IN_USE,
  LEDGER_LOCKED,
  LEDGER_NO_WEBUSB,
  LEDGER_NOT_CHOSEN,
  LEDGER_OPEN_APP,
  LEDGER_WRONG_KEY,
  toUserMessage,
} from "@/lib/utils/user-error";

// The Ledger libraries the installed kit ships, loaded from the kit's own dependencies so the
// error classes and status words are the exact ones the app runs with.
const kitRequire = createRequire(require.resolve("@creit-tech/stellar-wallets-kit/modules/ledger"));
const ledgerErrors = createRequire(kitRequire.resolve("@ledgerhq/hw-app-str"))("@ledgerhq/errors");

const INS_SIGN_TX = 0x04;
const INS_SIGN_HASH = 0x08;
const P2_MORE = 0x80;
// 1 path-length byte and three hardened indexes: 44'/148'/0'.
const PATH_BYTES = 13;
const OK = Buffer.from([0x90, 0x00]);

// Random throwaway keys: the device's account key, and another seed's.
const device = Keypair.random();
const otherSeed = Keypair.random();
const destination = Keypair.random().publicKey();

/** A WebUSB transport that answers the Stellar app's APDUs with `key`, or fails with `fail`. */
function fakeTransport(key: Keypair, fail?: () => Error) {
  const prompts: Array<{ ins: number; payload: Buffer }> = [];
  let chunks: Buffer[] = [];
  return {
    prompts,
    decorateAppAPIMethods: () => {},
    close: () => {},
    send: async (_cla: number, ins: number, _p1: number, p2: number, data: Buffer) => {
      if (fail) throw fail();
      chunks.push(Buffer.from(data));
      if (p2 === P2_MORE) return OK;
      const payload = Buffer.concat(chunks);
      chunks = [];
      prompts.push({ ins, payload });
      const body = payload.subarray(PATH_BYTES);
      const hash = ins === INS_SIGN_HASH ? body : createHash("sha256").update(body).digest();
      return Buffer.concat([Buffer.from(key.sign(hash)), OK]);
    },
  };
}

type Transport = ReturnType<typeof fakeTransport>;

/** The kit's real Ledger module, on a fake transport, behind the app's real signer. */
function ledgerSigner(
  transport: Transport,
  fingerprintShown: boolean
): { signer: WalletKitSigner; ledger: LedgerModule } {
  const ledger = new LedgerModule();
  (ledger as unknown as { _transport: Transport })._transport = transport;
  const signer = new WalletKitSigner(
    device.publicKey(),
    (xdr, opts) => ledger.signTransaction(xdr, opts),
    { walletId: LEDGER_WALLET_ID, fingerprintShown }
  );
  return { signer, ledger };
}

/** A close-shaped envelope from the device's account with `ops` trustline removals and a merge. */
function envelope(ops: number): string {
  const builder = new TransactionBuilder(new Account(device.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (let i = 0; i < ops; i++) {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset(`T${i}`, destination), limit: "0" })
    );
  }
  builder.addOperation(Operation.accountMerge({ destination }));
  return builder.build().toXDR();
}

const signatureBase = (xdr: string): Buffer =>
  Buffer.from(TransactionBuilder.fromXdr(xdr, Networks.TESTNET).signatureBase());
const hashOf = (xdr: string): Buffer =>
  Buffer.from(TransactionBuilder.fromXdr(xdr, Networks.TESTNET).hash());

const SMALL = envelope(2);
const OTHER_SMALL = envelope(3);
// 80 trustline removals put the signature base past what a Nano X buffers.
const LARGE = envelope(80);

const nav = globalThis.navigator as unknown as { usb?: unknown };
const ownUsb = Object.getOwnPropertyDescriptor(nav, "usb");

beforeEach(() => {
  Object.defineProperty(nav, "usb", {
    value: { getDevices: async () => [] },
    configurable: true,
  });
  hardwareWalletPaths.value = [{ publicKey: device.publicKey(), index: 0 }];
});

afterEach(() => {
  if (ownUsb) Object.defineProperty(nav, "usb", ownUsb);
  else Reflect.deleteProperty(nav, "usb");
  hardwareWalletPaths.value = [];
});

async function failureOf(promise: Promise<unknown>): Promise<WalletSigningError> {
  const err = await promise.then(
    () => null,
    (thrown: unknown) => thrown
  );
  if (!(err instanceof WalletSigningError))
    throw new Error(`expected a WalletSigningError: ${err}`);
  return err;
}

test("ledger › the app's id is the kit's", () => {
  expect(LEDGER_WALLET_ID).toBe(LEDGER_ID);
  expect(new LedgerModule().productId).toBe(LEDGER_ID);
});

test("ledger › the fixtures sit either side of the clear-signing limit", () => {
  expect(signatureBase(SMALL).length).toBeLessThanOrEqual(LEDGER_CLEAR_SIGNING_MAX_BYTES);
  expect(signatureBase(LARGE).length).toBeGreaterThan(LEDGER_CLEAR_SIGNING_MAX_BYTES);
});

test("ledger › a transaction that fits is shown in full: the device gets exactly its signature base", async () => {
  const transport = fakeTransport(device);
  const { signer } = ledgerSigner(transport, true);
  const signed = await signer.sign(SMALL, Networks.TESTNET);
  expect(transport.prompts).toHaveLength(1);
  expect(transport.prompts[0].ins).toBe(INS_SIGN_TX);
  expect(transport.prompts[0].payload.subarray(PATH_BYTES)).toEqual(signatureBase(SMALL));
  const tx = TransactionBuilder.fromXdr(signed, Networks.TESTNET);
  expect(Buffer.from(tx.hash()).toString("hex")).toBe(hashOf(SMALL).toString("hex"));
  expect(device.verify(tx.hash(), tx.signatures[0].signature.toBytes())).toBe(true);
});

test("ledger › one too large for every model is signed by its exact hash where the fingerprint shows", async () => {
  const transport = fakeTransport(device);
  const { signer } = ledgerSigner(transport, true);
  const signed = await signer.sign(LARGE, Networks.TESTNET);
  expect(transport.prompts).toHaveLength(1);
  expect(transport.prompts[0].ins).toBe(INS_SIGN_HASH);
  expect(transport.prompts[0].payload.subarray(PATH_BYTES)).toEqual(hashOf(LARGE));
  const signedHash = TransactionBuilder.fromXdr(signed, Networks.TESTNET).hash();
  expect(Buffer.from(signedHash).toString("hex")).toBe(hashOf(LARGE).toString("hex"));
});

test("ledger › where no fingerprint shows, even a large one is only ever shown in full", async () => {
  const transport = fakeTransport(device);
  const { signer } = ledgerSigner(transport, false);
  await signer.sign(LARGE, Networks.TESTNET);
  expect(transport.prompts.map((p) => p.ins)).toEqual([INS_SIGN_TX]);
});

for (const status of [0xb004, 0xb005]) {
  const hex = status.toString(16);
  test(`ledger › a device that cannot show it (0x${hex}) is not asked again by itself; the user's retry signs by hash`, async () => {
    let failing = true;
    let failedRequests = 0;
    const transport = fakeTransport(device);
    const send = transport.send;
    transport.send = async (...args: Parameters<typeof send>) => {
      if (failing) {
        failedRequests++;
        throw new ledgerErrors.TransportStatusError(status);
      }
      return send(...args);
    };
    const { signer } = ledgerSigner(transport, true);
    const err = await failureOf(signer.sign(SMALL, Networks.TESTNET));
    expect(err.hashSigningNext).toBe(true);
    expect(toUserMessage(err, "execute")).toBe(LEDGER_HASH_NEXT);
    expect(failedRequests).toBe(1);
    expect(transport.prompts).toHaveLength(0);

    failing = false;
    await signer.sign(SMALL, Networks.TESTNET);
    expect(transport.prompts.map((p) => p.ins)).toEqual([INS_SIGN_HASH]);
    expect(transport.prompts[0].payload.subarray(PATH_BYTES)).toEqual(hashOf(SMALL));
  });

  test(`ledger › after 0x${hex} on one transaction, another that fits is still shown in full`, async () => {
    let failing = true;
    const transport = fakeTransport(device);
    const send = transport.send;
    transport.send = async (...args: Parameters<typeof send>) => {
      if (failing) throw new ledgerErrors.TransportStatusError(status);
      return send(...args);
    };
    const { signer } = ledgerSigner(transport, true);
    expect((await failureOf(signer.sign(SMALL, Networks.TESTNET))).hashSigningNext).toBe(true);

    failing = false;
    await signer.sign(OTHER_SMALL, Networks.TESTNET);
    expect(transport.prompts.map((p) => p.ins)).toEqual([INS_SIGN_TX]);
    expect(transport.prompts[0].payload.subarray(PATH_BYTES)).toEqual(signatureBase(OTHER_SMALL));
    // The failed transaction itself, retried by the user, is still the one signed by hash.
    await signer.sign(SMALL, Networks.TESTNET);
    expect(transport.prompts.map((p) => p.ins)).toEqual([INS_SIGN_TX, INS_SIGN_HASH]);
    expect(transport.prompts[1].payload.subarray(PATH_BYTES)).toEqual(hashOf(SMALL));
  });

  test(`ledger › where no fingerprint shows, 0x${hex} never turns into hash signing`, async () => {
    const transport = fakeTransport(device, () => new ledgerErrors.TransportStatusError(status));
    const { signer } = ledgerSigner(transport, false);
    const err = await failureOf(signer.sign(SMALL, Networks.TESTNET));
    expect(err.hashSigningNext).toBe(false);
    expect(toUserMessage(err, "execute")).toBe(LEDGER_CANNOT_SHOW);
    const again = fakeTransport(device);
    (signer as unknown as { signWithKit: unknown }).signWithKit = (xdr: string, opts: object) => {
      const ledger = new LedgerModule();
      (ledger as unknown as { _transport: Transport })._transport = again;
      return ledger.signTransaction(xdr, opts);
    };
    await signer.sign(SMALL, Networks.TESTNET);
    expect(again.prompts.map((p) => p.ins)).toEqual([INS_SIGN_TX]);
  });
}

test("ledger › a rejection on the device is a decline, from the library's own class", async () => {
  const transport = fakeTransport(device, () => new ledgerErrors.TransportStatusError(0x6985));
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(err.device).toEqual({ status: 0x6985, name: "StellarUserRefusedError" });
  expect(err.message).toBe("User refused the request");
  expect(err.code).toBe(-4);
  expect(toUserMessage(err, "execute")).toContain("You declined the request in your wallet");
});

test.each([
  [0x6c66, "StellarHashSigningNotEnabledError", LEDGER_HASH_SIGNING_OFF],
  [0x6e00, "TransportStatusError", LEDGER_OPEN_APP],
  [0x6e01, "TransportStatusError", LEDGER_OPEN_APP],
  [0x6d00, "TransportStatusError", LEDGER_OPEN_APP],
  [0x6511, "TransportStatusError", LEDGER_OPEN_APP],
  [0x5515, "LockedDeviceError", LEDGER_LOCKED],
  [0x6982, "TransportStatusError", LEDGER_LOCKED],
])("ledger › status %d (%s) reads in plain words", async (status, name, copy) => {
  const transport = fakeTransport(device, () => new ledgerErrors.TransportStatusError(status));
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(err.device).toEqual({ status, name });
  expect(err.code).toBe(-1);
  expect(toUserMessage(err, "execute")).toBe(copy);
});

test.each([
  ["TransportRaceCondition", LEDGER_BUSY],
  ["TransportInterfaceNotAvailable", LEDGER_IN_USE],
  ["DisconnectedDevice", LEDGER_DISCONNECTED],
  ["DisconnectedDeviceDuringOperation", LEDGER_DISCONNECTED],
  ["TransportOpenUserCancelled", LEDGER_NOT_CHOSEN],
])("ledger › the transport's %s reads in plain words", async (name, copy) => {
  const transport = fakeTransport(device, () => new ledgerErrors[name]("raw library text"));
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(err.device.name).toBe(name);
  expect(toUserMessage(err, "execute")).toBe(copy);
});

test("ledger › a browser without WebUSB is told which browsers can reach the device", async () => {
  Reflect.deleteProperty(nav, "usb");
  const transport = fakeTransport(device);
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(err.message).toBe("Ledger wallets can not be used");
  expect(toUserMessage(err, "execute")).toBe(LEDGER_NO_WEBUSB);
  expect(transport.prompts).toHaveLength(0);
  const fromTransport = new WalletSigningError(
    -1,
    LEDGER_WALLET_ID,
    "Ledger can not be used with this device."
  );
  expect(toUserMessage(fromTransport, "execute")).toBe(LEDGER_NO_WEBUSB);
});

test("ledger › an account this browser did not load from the device is never signed at another path", async () => {
  hardwareWalletPaths.value = [];
  const transport = fakeTransport(device);
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(toUserMessage(err, "execute")).toBe(LEDGER_ACCOUNT_NOT_LOADED);
  expect(transport.prompts).toHaveLength(0);
});

test("ledger › a device holding another seed is caught before its signature is returned", async () => {
  const transport = fakeTransport(otherSeed);
  const err = await failureOf(ledgerSigner(transport, true).signer.sign(SMALL, Networks.TESTNET));
  expect(err.message).toBe("Invalid signature");
  expect(toUserMessage(err, "execute")).toBe(LEDGER_WRONG_KEY);
});

test("ledger › the device copy is only for a Ledger: the same text from another wallet is not read as one", () => {
  const other = new WalletSigningError(-1, "xbull", "Invalid signature", {
    status: 0x6c66,
    name: "LockedDeviceError",
  });
  expect(toUserMessage(other, "execute")).not.toBe(LEDGER_WRONG_KEY);
  expect(toUserMessage(other, "execute")).not.toBe(LEDGER_HASH_SIGNING_OFF);
  expect(toUserMessage(other, "execute")).not.toBe(LEDGER_LOCKED);
});

test("ledger › any other wallet is asked exactly as before, with no nonBlindTx", async () => {
  const seen: object[] = [];
  const signer = new WalletKitSigner(
    device.publicKey(),
    async (xdr, opts) => {
      seen.push(opts);
      const tx = TransactionBuilder.fromXdr(xdr, opts.networkPassphrase);
      tx.sign(device);
      return { signedTxXdr: tx.toEnvelope().toXdr("base64") };
    },
    { walletId: "xbull", fingerprintShown: true }
  );
  await signer.sign(LARGE, Networks.TESTNET);
  expect(seen).toEqual([{ networkPassphrase: Networks.TESTNET, address: device.publicKey() }]);
});

test("ledger › a refusal status from another wallet is not turned into a decline", () => {
  const thrown = Object.assign(new Error("x"), { statusCode: 0x6985 });
  const signer = new WalletKitSigner(device.publicKey(), () => Promise.reject(thrown), {
    walletId: "xbull",
  });
  return failureOf(signer.sign(SMALL, Networks.TESTNET)).then((err) => expect(err.code).toBe(-1));
});

test("ledger › a session found unusable before the wallet was asked stays that error", async () => {
  const signer = new WalletKitSigner(
    device.publicKey(),
    () => Promise.reject(new WalletNotUsableError("session", "testnet")),
    { walletId: LEDGER_WALLET_ID, fingerprintShown: true }
  );
  const err = await signer.sign(SMALL, Networks.TESTNET).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WalletNotUsableError);
});
