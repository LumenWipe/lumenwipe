import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import * as closeClient from "@/lib/api/close-client";
import * as sessionStore from "@/lib/session/store";
import { SignerReleasedError, WalletKitSigner, type TransactionSigner } from "@/lib/stellar/signer";
import type { SignTimer } from "@/lib/stellar/wallet-timeout";
import { submissionHash, submissionValidUntil } from "@/lib/stellar/submission";
import * as submitViaApiModule from "@/lib/stellar/submit-via-api";
import * as verifyModule from "@/lib/stellar/verify";
import { toHex } from "@/lib/stellar/hex";
import {
  KEPT_ROUND_DECLINED,
  KEPT_ROUND_TIMED_OUT,
  PENDING_ROUND_EXPIRED,
  SIGNED_NOT_APPROVED,
} from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

// A 2-of-3 account: the master key signs first and the round pauses at weight 1 of 2. The tests
// then stop the next signer in different ways and check whether that partly signed envelope is
// kept for the next attempt or cleared.
const master = Keypair.random();
const cosigner = Keypair.random();
const third = Keypair.random();
const SOURCE = master.publicKey();
const DEST = Keypair.random().publicKey();
const PASSPHRASE = Networks.TESTNET;
const ACCOUNT = {
  signers: [master, cosigner, third].map((k) => ({
    key: k.publicKey(),
    weight: 1,
    type: "ed25519_public_key",
  })),
  thresholds: { low: 1, med: 2, high: 2 },
};

const realNow = Date.now.bind(Date);
/** This device's clock as the hook reads it; null follows the real clock. */
let clock: number | null = null;

function mergeXdr(sequence = "100"): string {
  return new TransactionBuilder(new Account(SOURCE, sequence), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .setTimeout(300)
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .build()
    .toXdr();
}

function manageDataXdr(sequence = "100"): string {
  return new TransactionBuilder(new Account(SOURCE, sequence), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .setTimeout(300)
    .addOperation(Operation.manageData({ name: "k", value: null }))
    .build()
    .toXdr();
}

function planStep(index: number, type: string): unknown {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

function signWith(keypair: Keypair, xdr: string): string {
  const tx = TransactionBuilder.fromXdr(xdr, PASSPHRASE);
  tx.sign(keypair);
  return tx.toEnvelope().toXdr("base64");
}

function keySigner(keypair: Keypair): TransactionSigner & { calls: () => number } {
  let calls = 0;
  return {
    publicKey: keypair.publicKey(),
    sign: async (xdr) => {
      calls++;
      return signWith(keypair, xdr);
    },
    calls: () => calls,
  };
}

type KitAnswer = (xdr: string) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

function wallet(
  keypair: Keypair,
  answer: KitAnswer,
  startTimeout?: (ms: number) => SignTimer
): WalletKitSigner {
  return new WalletKitSigner(keypair.publicKey(), (xdr) => answer(xdr), {
    walletId: VARIAL_ID,
    startTimeout,
  });
}

/** A wallet that declines, as the kit reports it: code -4, rejected by the user. */
const declining = (): WalletKitSigner =>
  wallet(cosigner, async () => {
    throw { code: -4, message: "User declined access" };
  });

/** A wallet whose prompt is never answered, and whose timeout runs out at once. */
const timingOut = (): WalletKitSigner =>
  wallet(
    cosigner,
    () => new Promise(() => {}),
    () => ({ expired: Promise.resolve(), cancel: () => {} })
  );

interface Setup {
  xdr: string;
  fetches: () => number;
  submitted: string[];
}

function setup(transactions?: { id: string; xdr: string; covers: string[] }[]): Setup {
  const xdr = mergeXdr();
  const txs = (transactions ?? [{ id: "t0", xdr, covers: ["MERGE"] }]).map((tx, order) => ({
    ...tx,
    order,
  }));
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    mediatorRequired: false,
    lastError: null,
    lastErrorReference: null,
    accountState: ACCOUNT as never,
    executionPlan: txs.map((tx, i) => planStep(i, tx.covers[0])),
  } as never);
  let fetches = 0;
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async () => {
    fetches++;
    return {
      planHash: "h",
      status: "ready",
      transactions: txs,
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  }) as unknown as typeof closeClient.fetchCloseTransactions);
  const submitted: string[] = [];
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation((async (sent: string) => {
    submitted.push(sent);
    return { ledger: 0, txHash: submissionHash(sent, PASSPHRASE) };
  }) as unknown as typeof submitViaApiModule.submitViaApi);
  return { xdr: txs[0].xdr, fetches: () => fetches, submitted };
}

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useCloseExecution>, unknown>>;

async function run(
  hook: Hook,
  signer: TransactionSigner | null,
  options?: Parameters<ReturnType<typeof useCloseExecution>["run"]>[1]
): Promise<void> {
  await act(async () => {
    await hook.result.current.run(signer, options);
  });
}

/** Renders the hook and pauses the round with the master key's signature on it. */
async function pausedAfterMaster(): Promise<Hook> {
  const hook = renderHook(() => useCloseExecution());
  await run(hook, keySigner(master));
  expect(hook.result.current.signatureStatus?.accumulatedWeight).toBe(1);
  return hook;
}

function validUntilMs(xdr: string): number {
  return submissionValidUntil(xdr, PASSPHRASE)! * 1000;
}

beforeEach(() => {
  installIndexedDb();
  useDemolishStore.getState().reset();
  clock = null;
  spyOn(Date, "now").mockImplementation(() => clock ?? realNow());
  useDemolishStore.setState({
    unconfirmedSubmission: null,
    sessionId: "session",
    signingRun: false,
  });
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true);
  spyOn(sessionStore, "recordConfirmed").mockImplementation(async () => true);
  spyOn(sessionStore, "loadSession").mockImplementation(async () => ({ id: "session" }) as never);
});
afterEach(() => {
  mock.restore();
  removeIndexedDb();
});

test.each([
  ["declines", declining, KEPT_ROUND_DECLINED],
  ["times out", timingOut, KEPT_ROUND_TIMED_OUT],
] as const)(
  "useCloseExecution › a wallet that %s on a resumed round keeps it, and the next signer resumes the same envelope",
  async (_, stopping, notice) => {
    const { xdr, fetches, submitted } = setup();
    const hook = await pausedAfterMaster();

    await run(hook, stopping());

    const status = hook.result.current.signatureStatus;
    expect(status?.accumulatedWeight).toBe(1);
    expect(status?.requiredWeight).toBe(2);
    expect(status?.contributed.map((s) => s.key)).toEqual([SOURCE]);
    expect(status?.notice).toBe(notice);
    const state = useDemolishStore.getState();
    expect(state.phase).toBe("STEP_FAILED");
    expect(state.lastError).toBe(notice);
    expect(state.signingRun).toBe(false);
    expect(state.executionPlan[0].status).toBe("pending");
    expect(hook.result.current.retrySafe).toBe(true);
    expect(submitted).toHaveLength(0);

    // The next signer resumes onto the kept envelope: no new build, same body, both signatures.
    await run(hook, keySigner(cosigner));
    expect(fetches()).toBe(1);
    expect(useDemolishStore.getState().phase).toBe("COMPLETE");
    expect(submitted).toHaveLength(1);
    const sent = TransactionBuilder.fromXdr(submitted[0], PASSPHRASE);
    expect(toHex(sent.hash())).toBe(toHex(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash()));
    expect(sent.signatures).toHaveLength(2);
  }
);

/** Every way a resumed signing can stop other than the wallet's own decline or timeout. */
// Every row names its run options, so the test callback always gets three arguments: Bun reads a
// callback with more parameters than the row has values as one that waits for `done`.
const otherStops: [string, () => TransactionSigner, { beforeSign?: () => Promise<void> }][] = [
  [
    "a wallet error the kit codes -1, even worded as a decline",
    () =>
      wallet(cosigner, async () => {
        throw { code: -1, message: "User declined access" };
      }),
    {},
  ],
  [
    "a wallet error the kit codes -3",
    () =>
      wallet(cosigner, async () => {
        throw { code: -3, message: "Not supported" };
      }),
    {},
  ],
  [
    "a wallet that reports another account",
    () =>
      wallet(cosigner, async (xdr) => ({
        signedTxXdr: signWith(third, xdr),
        signerAddress: third.publicKey(),
      })),
    {},
  ],
  [
    "a wallet that signs with another of the account's keys and reports nothing",
    () => wallet(cosigner, async (xdr) => ({ signedTxXdr: signWith(third, xdr) })),
    {},
  ],
  [
    "a wallet that adds no signature",
    () => wallet(cosigner, async (xdr) => ({ signedTxXdr: xdr })),
    {},
  ],
  [
    "a signer that fails outside any wallet",
    () => ({
      publicKey: cosigner.publicKey(),
      sign: async () => {
        throw new Error("boom");
      },
    }),
    {},
  ],
  [
    "a signer the screen released before it was asked",
    () => keySigner(cosigner),
    {
      beforeSign: async () => {
        throw new SignerReleasedError();
      },
    },
  ],
];

test.each(otherStops)(
  "useCloseExecution › %s on a resumed round clears it, and the next attempt builds a new one",
  async (_, stopping, options) => {
    const { fetches, submitted } = setup();
    const hook = await pausedAfterMaster();

    await run(hook, stopping(), options);

    expect(hook.result.current.signatureStatus).toBeNull();
    expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
    expect(submitted).toHaveLength(0);

    await run(hook, keySigner(master));
    expect(fetches()).toBe(2);
  }
);

test("useCloseExecution › a refusal of what the wallet returned on a resumed round names it and clears the round", async () => {
  setup();
  const hook = await pausedAfterMaster();
  await run(
    hook,
    wallet(cosigner, async () => ({ signedTxXdr: signWith(cosigner, mergeXdr("200")) }))
  );
  expect(useDemolishStore.getState().lastError).toContain(SIGNED_NOT_APPROVED);
  expect(hook.result.current.signatureStatus).toBeNull();
});

test("useCloseExecution › a decline on a later transaction of a resumed run clears the round it resumed", async () => {
  // The resumed round is submitted first; the decline comes on the next transaction of the batch,
  // so the round left in memory is one that was already sent.
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  const { fetches, submitted } = setup([
    { id: "t0", xdr: manageDataXdr("100"), covers: ["HANDLE_ASSETS"] },
    { id: "t1", xdr: mergeXdr("101"), covers: ["MERGE"] },
  ]);
  const hook = await pausedAfterMaster();

  let calls = 0;
  await run(
    hook,
    wallet(cosigner, async (xdr) => {
      if (calls++ > 0) throw { code: -4, message: "User declined access" };
      return { signedTxXdr: signWith(cosigner, xdr) };
    })
  );

  expect(submitted).toHaveLength(1);
  expect(hook.result.current.signatureStatus).toBeNull();
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");

  await run(hook, keySigner(master));
  expect(fetches()).toBe(2);
});

test.each([
  ["declines", declining],
  ["times out", timingOut],
] as const)(
  "useCloseExecution › a wallet that %s once the resumed round has reached its time limit clears it",
  async (_, stopping) => {
    const { xdr, fetches } = setup();
    const hook = await pausedAfterMaster();
    const stopper = stopping();
    // The clock reaches the envelope's upper bound while the wallet is asked: exactly at it, the
    // envelope is already expired.
    const asked = stopper.sign.bind(stopper);
    stopper.sign = async (signing, passphrase) => {
      clock = validUntilMs(xdr);
      return asked(signing, passphrase);
    };

    await run(hook, stopper);

    expect(hook.result.current.signatureStatus).toBeNull();
    expect(useDemolishStore.getState().lastError).not.toBe(KEPT_ROUND_DECLINED);
    expect(useDemolishStore.getState().lastError).not.toBe(KEPT_ROUND_TIMED_OUT);
    expect(useDemolishStore.getState().executionPlan[0].status).toBe("failed");

    clock = null;
    await run(hook, keySigner(master));
    expect(fetches()).toBe(2);
  }
);

const nextRuns: [string, () => ReturnType<typeof keySigner> | null][] = [
  ["a signer", () => keySigner(cosigner)],
  ["no signer", () => null],
];

test.each(nextRuns)(
  "useCloseExecution › a kept round past its time limit is dropped with a plain message when the next run starts with %s",
  async (_, next) => {
    const { xdr, fetches, submitted } = setup();
    const hook = await pausedAfterMaster();
    await run(hook, declining());
    expect(hook.result.current.signatureStatus).not.toBeNull();

    clock = validUntilMs(xdr);
    const signer = next();
    await run(hook, signer);

    const state = useDemolishStore.getState();
    expect(state.lastError).toBe(PENDING_ROUND_EXPIRED);
    expect(state.phase).toBe("STEP_FAILED");
    expect(state.signingRun).toBe(false);
    expect(hook.result.current.signatureStatus).toBeNull();
    expect(hook.result.current.retrySafe).toBe(true);
    expect(fetches()).toBe(1);
    expect(submitted).toHaveLength(0);
    if (signer) expect(signer.calls()).toBe(0);

    // Retry builds a new transaction.
    clock = null;
    await run(hook, keySigner(master));
    expect(fetches()).toBe(2);
  }
);

test("useCloseExecution › a paused round with no upper time bound is never resumed", async () => {
  // verify() refuses such an envelope, so it is stubbed here to reach the resume at all.
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => undefined as never);
  const unbounded = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .setTimeout(0)
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .build()
    .toXdr();
  const { fetches, submitted } = setup([{ id: "t0", xdr: unbounded, covers: ["MERGE"] }]);
  const hook = await pausedAfterMaster();

  const next = keySigner(cosigner);
  await run(hook, next);

  expect(useDemolishStore.getState().lastError).toBe(PENDING_ROUND_EXPIRED);
  expect(next.calls()).toBe(0);
  expect(fetches()).toBe(1);
  expect(submitted).toHaveLength(0);
});

test("useCloseExecution › a run with no signer on a kept round pauses on the same envelope again", async () => {
  const { fetches, submitted } = setup();
  const hook = await pausedAfterMaster();
  await run(hook, declining());

  await run(hook, null);

  expect(fetches()).toBe(1);
  expect(submitted).toHaveLength(0);
  expect(hook.result.current.signatureStatus?.accumulatedWeight).toBe(1);
  expect(hook.result.current.signatureStatus?.notice).toBeNull();

  await run(hook, keySigner(cosigner));
  expect(fetches()).toBe(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});
