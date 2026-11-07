import { describe, expect, test } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  WALLET_CONNECT_WALLET_ID,
  WalletKitSigner,
  WalletSigningError,
  WalletSigningTimeoutError,
} from "@/lib/stellar/signer";
import {
  SUBMIT_MARGIN_MS,
  WALLET_SIGN_MIN_TIMEOUT_MS,
  WALLET_SIGN_TIMEOUT_MS,
  signTimeoutMs,
  type SignTimer,
} from "@/lib/stellar/wallet-timeout";
import { WALLET_CONNECT_ID } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";

const NOW = 1_800_000_000_000;
const source = Keypair.random();

/** An unsigned merge valid until `maxTime` (seconds), or with no upper bound when it is 0. */
function mergeXdr(maxTime: number): string {
  return new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }))
    .build()
    .toXdr();
}

const FRESH = mergeXdr(NOW / 1000 + 300);

/** A timeout the test runs out by hand, recording what it was started with. */
function manualTimer(): {
  start: (ms: number) => SignTimer;
  expire: () => void;
  started: number[];
  cancelled: () => number;
} {
  const started: number[] = [];
  let expire = (): void => {};
  let cancelled = 0;
  return {
    started,
    start: (ms) => {
      started.push(ms);
      return {
        expired: new Promise<void>((resolve) => (expire = resolve)),
        cancel: () => {
          cancelled += 1;
        },
      };
    },
    expire: () => expire(),
    cancelled: () => cancelled,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err
  );
}

describe("WalletKitSigner errors", () => {
  test.each([
    ["a kit error", { code: -4, message: "The user rejected this request." }, -4],
    ["a nested wallet error", { error: { code: -3, message: "Not supported" } }, -3],
    ["an error with no code", new Error("boom"), -1],
    ["a non-numeric code", { code: "USER_REJECTED", message: "no" }, -1],
  ])("%s is thrown as a typed wallet error with the wallet's code", async (_, thrown, code) => {
    const timer = manualTimer();
    const signer = new WalletKitSigner(
      source.publicKey(),
      async () => {
        throw thrown;
      },
      { walletId: "freighter", startTimeout: timer.start, now: () => NOW }
    );
    const err = await caught(signer.sign(FRESH, Networks.TESTNET));
    expect(err).toBeInstanceOf(WalletSigningError);
    expect((err as WalletSigningError).code).toBe(code);
    expect((err as WalletSigningError).walletId).toBe("freighter");
    expect(timer.cancelled()).toBe(1);
  });

  test("a kit that throws before returning a promise is typed too", async () => {
    const signer = new WalletKitSigner(
      source.publicKey(),
      () => {
        throw { code: -3, message: "Please set the wallet first" };
      },
      { startTimeout: manualTimer().start, now: () => NOW }
    );
    const err = await caught(signer.sign(FRESH, Networks.TESTNET));
    expect((err as WalletSigningError).code).toBe(-3);
    expect((err as WalletSigningError).walletId).toBeNull();
  });
});

describe("WalletKitSigner timeout", () => {
  test("a wallet that never answers ends in the typed timeout after the time it was given", async () => {
    const timer = manualTimer();
    const signer = new WalletKitSigner(source.publicKey(), () => new Promise<never>(() => {}), {
      walletId: WALLET_CONNECT_WALLET_ID,
      startTimeout: timer.start,
      now: () => NOW,
    });
    const signing = caught(signer.sign(FRESH, Networks.TESTNET));
    timer.expire();
    const err = await signing;
    expect(err).toBeInstanceOf(WalletSigningTimeoutError);
    expect((err as WalletSigningTimeoutError).walletId).toBe(WALLET_CONNECT_WALLET_ID);
    expect(timer.started).toEqual([WALLET_SIGN_TIMEOUT_MS]);
  });

  test("a signature arriving after the timeout is dropped, and the next attempt gets its own", async () => {
    const timer = manualTimer();
    const late = deferred<{ signedTxXdr: string }>();
    const answers = [late.promise, Promise.resolve({ signedTxXdr: "second" })];
    let asked = 0;
    const signer = new WalletKitSigner(source.publicKey(), () => answers[asked++]!, {
      startTimeout: timer.start,
      now: () => NOW,
    });

    const first = caught(signer.sign(FRESH, Networks.TESTNET));
    timer.expire();
    expect(await first).toBeInstanceOf(WalletSigningTimeoutError);
    late.resolve({ signedTxXdr: "first, too late" });

    expect(await signer.sign(FRESH, Networks.TESTNET)).toBe("second");
    expect(asked).toBe(2);
  });

  test("an answer in time is returned and its timeout cancelled", async () => {
    const timer = manualTimer();
    const signer = new WalletKitSigner(
      source.publicKey(),
      async () => ({ signedTxXdr: "signed" }),
      { startTimeout: timer.start, now: () => NOW }
    );
    expect(await signer.sign(FRESH, Networks.TESTNET)).toBe("signed");
    expect(timer.cancelled()).toBe(1);
  });

  test("the wait is cut short so a late signature can still be prepared and sent in time", async () => {
    const timer = manualTimer();
    const signer = new WalletKitSigner(
      source.publicKey(),
      async () => ({ signedTxXdr: "signed" }),
      { startTimeout: timer.start, now: () => NOW }
    );
    await signer.sign(mergeXdr(NOW / 1000 + 150), Networks.TESTNET);
    expect(timer.started).toEqual([150_000 - SUBMIT_MARGIN_MS]);
  });

  test("a device clock ten minutes fast still asks the wallet, with the shortest wait", async () => {
    const timer = manualTimer();
    let asked = 0;
    const signer = new WalletKitSigner(
      source.publicKey(),
      async () => {
        asked += 1;
        return { signedTxXdr: "signed" };
      },
      // The API built this transaction valid for 300 s by its own clock.
      { startTimeout: timer.start, now: () => NOW + 600_000 }
    );
    expect(await signer.sign(FRESH, Networks.TESTNET)).toBe("signed");
    expect(asked).toBe(1);
    expect(timer.started).toEqual([WALLET_SIGN_MIN_TIMEOUT_MS]);
  });

  test("a prompt given up on is reported open until the wallet answers it", async () => {
    const timer = manualTimer();
    const late = deferred<{ signedTxXdr: string }>();
    const signer = new WalletKitSigner(source.publicKey(), () => late.promise, {
      startTimeout: timer.start,
      now: () => NOW,
    });
    expect(signer.stalePrompt()).toBeNull();
    const signing = caught(signer.sign(FRESH, Networks.TESTNET));
    timer.expire();
    await signing;
    const stale = signer.stalePrompt();
    expect(stale).not.toBeNull();
    late.resolve({ signedTxXdr: "too late" });
    await stale;
    await Promise.resolve();
    expect(signer.stalePrompt()).toBeNull();
  });

  test("an answer in time leaves no open prompt", async () => {
    const signer = new WalletKitSigner(
      source.publicKey(),
      async () => ({ signedTxXdr: "signed" }),
      { startTimeout: manualTimer().start, now: () => NOW }
    );
    await signer.sign(FRESH, Networks.TESTNET);
    expect(signer.stalePrompt()).toBeNull();
  });
});

test("signTimeoutMs is the validity window less the margin, kept between 30 s and two minutes", () => {
  expect(signTimeoutMs(null, NOW)).toBe(WALLET_SIGN_TIMEOUT_MS);
  expect(signTimeoutMs(NOW / 1000 + 300, NOW)).toBe(WALLET_SIGN_TIMEOUT_MS);
  expect(signTimeoutMs(NOW / 1000 + 200, NOW)).toBe(100_000);
  // A tiny positive remainder and a window already past are both the 30 s floor.
  expect(signTimeoutMs(NOW / 1000 + 101, NOW)).toBe(WALLET_SIGN_MIN_TIMEOUT_MS);
  expect(signTimeoutMs(NOW / 1000 - 600, NOW)).toBe(WALLET_SIGN_MIN_TIMEOUT_MS);
});

test("the WalletConnect id is the kit's own", () => {
  expect(WALLET_CONNECT_WALLET_ID).toBe(WALLET_CONNECT_ID);
});
