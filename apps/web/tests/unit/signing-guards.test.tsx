import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  Account,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import * as closeClient from "@/lib/api/close-client";
import { HashXPreimageSigner, type TransactionSigner } from "@/lib/stellar/signer";
import * as submitViaApiModule from "@/lib/stellar/submit-via-api";
import * as verifyModule from "@/lib/stellar/verify";
import { fromHex } from "@/lib/stellar/hex";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountSigner } from "@/types/account";

const master = Keypair.random();
const cosigner = Keypair.random();
const SOURCE = master.publicKey();
const DEST = Keypair.random().publicKey();
const PREIMAGE = fromHex("deadbeef");
const HASH_X = StrKey.encodeSha256Hash(hash(PREIMAGE));
const OTHER_PREIMAGE = fromHex("cafebabe");
const CLAIM = Operation.claimClaimableBalance({ balanceId: `00000000${"ab".repeat(32)}` });
const REMOVE_HASH_X = Operation.setOptions({ signer: { sha256Hash: hash(PREIMAGE), weight: 0 } });
const REMOVE_OTHER_HASH_X = Operation.setOptions({
  signer: { sha256Hash: hash(OTHER_PREIMAGE), weight: 0 },
});
const REMOVE_COSIGNER = Operation.setOptions({
  signer: { ed25519PublicKey: cosigner.publicKey(), weight: 0 },
});
const RESET = Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 });
const MERGE = Operation.accountMerge({ destination: DEST });

const signerEntries: Record<string, AccountSigner> = {
  master: { key: SOURCE, weight: 1, type: "ed25519_public_key" },
  cosigner: { key: cosigner.publicKey(), weight: 2, type: "ed25519_public_key" },
  hashX: { key: HASH_X, weight: 2, type: "hash_x" },
};

function envelope(ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toXdr();
}

function keySigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (signing, passphrase) => {
      const built = TransactionBuilder.fromXdr(signing, passphrase);
      built.sign(keypair);
      return built.toEnvelope().toXdr("base64");
    },
  };
}

function preimageSigner(): { signer: TransactionSigner; signed: () => boolean } {
  const real = new HashXPreimageSigner(HASH_X, PREIMAGE);
  const sign = spyOn(real, "sign");
  return { signer: real, signed: () => sign.mock.calls.length > 0 };
}

function setup(
  ops: xdr.Operation[],
  signers: AccountSigner[],
  high: number,
  covers = ["NORMALIZE_SIGNERS"]
) {
  const submit = spyOn(submitViaApiModule, "submitViaApi").mockImplementation((async () => ({
    txHash: "h",
  })) as unknown as typeof submitViaApiModule.submitViaApi);
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: envelope(ops), covers }],
    remaining: { steps: 0, requiresAnotherCall: false },
  })) as unknown as typeof closeClient.fetchCloseTransactions);
  useDemolishStore.setState({
    accountState: { signers, thresholds: { low: high, med: high, high } },
  } as never);
  return { submit, hook: renderHook(() => useCloseExecution()).result };
}

async function runWith(
  hook: { current: ReturnType<typeof useCloseExecution> },
  signer: TransactionSigner
): Promise<void> {
  await act(async () => {
    await hook.current.run(signer);
  });
}

beforeEach(() => {
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => {});
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    mediatorRequired: false,
  } as never);
});

afterEach(() => {
  mock.restore();
});

test("a preimage is never attached to a claim round, whatever the round says it covers", async () => {
  const { submit, hook } = setup([CLAIM], [signerEntries.master!, signerEntries.hashX!], 2);
  const { signer, signed } = preimageSigner();

  await runWith(hook, signer);

  expect(signed()).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(useDemolishStore.getState().lastError).toContain("This preimage can't be used");
  expect(useDemolishStore.getState().lastError).toContain("Nothing was signed or sent");
});

test("a paused exit round refuses the preimage and stops instead of carrying it", async () => {
  const { submit, hook } = setup([CLAIM], [signerEntries.master!, signerEntries.hashX!], 3, [
    "DEFI_EXIT",
  ]);
  await runWith(hook, keySigner(master));
  expect(hook.current.signatureStatus?.accumulatedWeight).toBe(1);
  const { signer, signed } = preimageSigner();

  await runWith(hook, signer);

  expect(signed()).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(hook.current.signatureStatus).toBeNull();
});

test("a transaction removing a different hash(x) signer does not admit this preimage", async () => {
  const { submit, hook } = setup(
    [REMOVE_OTHER_HASH_X, RESET],
    [signerEntries.master!, signerEntries.hashX!],
    2
  );
  const { signer, signed } = preimageSigner();

  await runWith(hook, signer);

  expect(signed()).toBe(false);
  expect(submit).not.toHaveBeenCalled();
});

test("a transaction that keeps this hash(x) signer at a weight does not admit its preimage", async () => {
  const { submit, hook } = setup(
    [Operation.setOptions({ signer: { sha256Hash: hash(PREIMAGE), weight: 1 } })],
    [signerEntries.master!, signerEntries.hashX!],
    2
  );
  const { signer, signed } = preimageSigner();

  await runWith(hook, signer);

  expect(signed()).toBe(false);
  expect(submit).not.toHaveBeenCalled();
});

test("a preimage is accepted on the normalization that removes its own signer", async () => {
  const { submit, hook } = setup(
    [REMOVE_HASH_X, RESET],
    [signerEntries.master!, signerEntries.hashX!],
    3
  );
  await runWith(hook, keySigner(master));
  const { signer, signed } = preimageSigner();

  await runWith(hook, signer);

  expect(signed()).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("a removal of signers with no merge, signed by co-signers alone, is not submitted", async () => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER, RESET],
    [signerEntries.master!, signerEntries.cosigner!],
    2
  );

  await runWith(hook, keySigner(cosigner));

  expect(submit).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(useDemolishStore.getState().lastError).toContain("must include the account's master key");
  expect(useDemolishStore.getState().lastError).toContain("your funds stay where they are");
});

test("a removal with no merge and no threshold reset is not submitted, even signed by the master key", async () => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER],
    [signerEntries.master!, signerEntries.cosigner!],
    2
  );

  await runWith(hook, keySigner(master));
  await runWith(hook, keySigner(cosigner));

  expect(submit).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(useDemolishStore.getState().lastError).toContain(
    "without resetting the account's thresholds"
  );
});

test.each([
  ["low", { lowThreshold: 2, medThreshold: 1, highThreshold: 1 }],
  ["med", { lowThreshold: 0, medThreshold: 2, highThreshold: 1 }],
  ["high", { lowThreshold: 0, medThreshold: 1, highThreshold: 2 }],
  ["only part of", { lowThreshold: 0, medThreshold: 1 }],
])("a reset leaving %s the thresholds out of reach is not accepted", async (_, thresholds) => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER, Operation.setOptions(thresholds)],
    [signerEntries.master!, signerEntries.cosigner!],
    2
  );

  await runWith(hook, keySigner(master));
  await runWith(hook, keySigner(cosigner));

  expect(submit).not.toHaveBeenCalled();
});

test("a threshold reset on another account's behalf does not count", async () => {
  const { submit, hook } = setup(
    [
      REMOVE_COSIGNER,
      Operation.setOptions({
        source: DEST,
        lowThreshold: 0,
        medThreshold: 1,
        highThreshold: 1,
      }),
    ],
    [signerEntries.master!, signerEntries.cosigner!],
    2
  );

  await runWith(hook, keySigner(master));
  await runWith(hook, keySigner(cosigner));

  expect(submit).not.toHaveBeenCalled();
});

test("the same removal is submitted once the master key has signed it", async () => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER, RESET],
    [signerEntries.master!, signerEntries.cosigner!],
    2
  );

  await runWith(hook, keySigner(master));
  expect(submit).not.toHaveBeenCalled();
  await runWith(hook, keySigner(cosigner));

  expect(submit).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("a close that merges in the same transaction still works with co-signers alone", async () => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER, RESET, MERGE],
    [signerEntries.master!, signerEntries.cosigner!],
    2,
    ["NORMALIZE_SIGNERS", "MERGE"]
  );

  await runWith(hook, keySigner(cosigner));

  expect(submit).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("a round that removes no signer needs no master key", async () => {
  const { submit, hook } = setup([CLAIM], [signerEntries.master!, signerEntries.cosigner!], 2, [
    "CLAIM_BALANCES",
  ]);

  await runWith(hook, keySigner(cosigner));

  expect(submit).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});

test("a multisig round short of its weight stays resumable, and no check fires before it is met", async () => {
  const { submit, hook } = setup(
    [REMOVE_COSIGNER, RESET],
    [signerEntries.master!, signerEntries.cosigner!],
    3
  );

  await runWith(hook, keySigner(cosigner));

  expect(hook.current.signatureStatus?.accumulatedWeight).toBe(2);
  expect(useDemolishStore.getState().lastError).toContain("more signing weight");
  expect(submit).not.toHaveBeenCalled();

  await runWith(hook, keySigner(master));

  expect(closeClient.fetchCloseTransactions).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("COMPLETE");
});
