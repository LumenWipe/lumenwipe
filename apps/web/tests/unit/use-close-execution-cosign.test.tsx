import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import * as analyzeClient from "@/lib/api/analyze-client";
import * as closeClient from "@/lib/api/close-client";
import { parseCosignArtifact, serializeCosignArtifact } from "@/lib/cosign/artifact";
import { COSIGN_REFUSED } from "@/lib/cosign/merge";
import * as sessionStore from "@/lib/session/store";
import { toHex } from "@/lib/stellar/hex";
import type { TransactionSigner } from "@/lib/stellar/signer";
import * as submitViaApiModule from "@/lib/stellar/submit-via-api";
import * as verifyModule from "@/lib/stellar/verify";
import { ApiRequestError } from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountSigner, AccountState } from "@/types/account";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

// A 3-of-3 account: no key reaches the thresholds alone, so normalization is its own transaction
// and the two cosigners sign it on their own devices.
const master = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const SOURCE = master.publicKey();
const DEST = Keypair.random().publicKey();
const PASSPHRASE = Networks.TESTNET;
const SIGNERS: AccountSigner[] = [master, b, c].map((k) => ({
  key: k.publicKey(),
  weight: 1,
  type: "ed25519_public_key",
}));
const THRESHOLDS = { low: 0, med: 3, high: 3 };

const NORMALIZATION = new TransactionBuilder(new Account(SOURCE, "100"), {
  fee: "100",
  networkPassphrase: PASSPHRASE,
})
  .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: b.publicKey(), weight: 0 } }))
  .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: c.publicKey(), weight: 0 } }))
  .addOperation(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
  .setTimeout(300)
  .build();
const UNSIGNED = NORMALIZATION.toEnvelope().toXDR("base64");
const INNER_HASH = toHex(NORMALIZATION.hash());

function keySigner(keypair: Keypair): TransactionSigner & { calls: () => number } {
  let calls = 0;
  return {
    publicKey: keypair.publicKey(),
    sign: async (xdr, passphrase) => {
      calls++;
      const tx = TransactionBuilder.fromXdr(xdr, passphrase);
      tx.sign(keypair);
      return tx.toEnvelope().toXDR("base64");
    },
    calls: () => calls,
  };
}

function responseFrom(request: string, keypair: Keypair): string {
  const artifact = parseCosignArtifact(request, "request");
  const tx = TransactionBuilder.fromXdr(artifact.envelope, PASSPHRASE);
  tx.sign(keypair);
  return serializeCosignArtifact({
    ...artifact,
    direction: "response",
    envelope: tx.toEnvelope().toXDR("base64"),
  });
}

function liveAccount(signers = SIGNERS, sequence = "100"): AccountState {
  return { address: SOURCE, sequence, signers, thresholds: THRESHOLDS } as AccountState;
}

let submitted: string[];
let readLive: ReturnType<typeof spyOn>;
type Hook = { current: ReturnType<typeof useCloseExecution> };

beforeEach(() => {
  installIndexedDb();
  submitted = [];
  spyOn(verifyModule, "verifyCloseTransaction").mockImplementation(() => {});
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true);
  spyOn(sessionStore, "loadSession").mockImplementation(async () => ({ id: "session" }) as never);
  spyOn(closeClient, "fetchCloseTransactions").mockImplementation((async () => ({
    planHash: "h",
    status: "ready",
    transactions: [{ id: "t0", order: 0, xdr: UNSIGNED, covers: ["NORMALIZE_SIGNERS"] }],
    remaining: { steps: 0, requiresAnotherCall: false },
  })) as unknown as typeof closeClient.fetchCloseTransactions);
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation((async (xdr: string) => {
    submitted.push(xdr);
    return { txHash: toHex(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash()), ledger: 1 };
  }) as unknown as typeof submitViaApiModule.submitViaApi);
  readLive = spyOn(analyzeClient, "readAccount").mockImplementation(async () => liveAccount());
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({
    sessionId: "session",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    accountState: { signers: SIGNERS, thresholds: THRESHOLDS },
  } as never);
});

afterEach(() => {
  mock.restore();
  removeIndexedDb();
});

async function pausedOnMaster(): Promise<{ hook: Hook; request: string }> {
  const hook = renderHook(() => useCloseExecution()).result;
  await act(async () => {
    await hook.current.run(keySigner(master));
  });
  const exported = hook.current.cosign?.export;
  if (!exported?.available) throw new Error("no export");
  return { hook, request: exported.request };
}

async function resumeCosigned(hook: Hook): Promise<void> {
  await act(async () => {
    await hook.current.run(null, { cosignedResume: true });
  });
}

test("the paused round is pinned and exported unsigned, with its hash kept out of the file", async () => {
  const { hook, request } = await pausedOnMaster();
  expect(hook.current.cosign?.export).toMatchObject({ available: true, hash: INNER_HASH });
  expect(parseCosignArtifact(request, "request").envelope).toBe(UNSIGNED);
  expect(request).not.toContain(INNER_HASH);
});

test("merged responses resume through the engine with no signer and submit the minimal set", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    expect(hook.current.importCosignResponse(responseFrom(request, b))).toBeNull();
  });
  expect(hook.current.cosign).toMatchObject({ collectedWeight: 2, ready: false });
  act(() => {
    expect(hook.current.importCosignResponse(responseFrom(request, c))).toBeNull();
  });
  expect(hook.current.cosign).toMatchObject({ collectedWeight: 3, ready: true });

  await resumeCosigned(hook);

  expect(readLive).toHaveBeenCalledTimes(1);
  expect(readLive.mock.calls[0]?.slice(0, 2)).toEqual(["testnet", SOURCE]);
  expect(submitted).toHaveLength(1);
  const sent = TransactionBuilder.fromXdr(submitted[0]!, PASSPHRASE);
  expect(toHex(sent.hash())).toBe(INNER_HASH);
  expect(sent.signatures).toHaveLength(3);
});

test("a merged round is never submitted by a run that did not ask to resume it", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  await act(async () => {
    await hook.current.run(null);
  });
  expect(submitted).toHaveLength(0);
});

test("a response refused by the merge says why and changes nothing", async () => {
  const { hook, request } = await pausedOnMaster();
  let refusal = null as string | null;
  act(() => {
    refusal = hook.current.importCosignResponse(responseFrom(request, Keypair.random()));
  });
  expect(refusal).toBe(COSIGN_REFUSED.unknownKey);
  expect(hook.current.cosign).toMatchObject({ collectedWeight: 1, ready: false });
});

test("signers that changed since the build stop the cosigned round before anything is sent", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  const added = {
    key: Keypair.random().publicKey(),
    weight: 1,
    type: "ed25519_public_key" as const,
  };
  readLive.mockImplementation(async () => liveAccount([...SIGNERS, added]));

  await resumeCosigned(hook);

  expect(submitted).toHaveLength(0);
  expect(useDemolishStore.getState().lastError).toContain(COSIGN_REFUSED.signersChanged);
});

test("a cosigned round already confirmed elsewhere is found by its inner hash", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation(async () => {
    throw new ApiRequestError(400, "tx_bad_seq");
  });
  const lookup = spyOn(submitViaApiModule, "lookupViaApi").mockImplementation((async (
    hash: string
  ) => ({ status: "confirmed", hash, ledger: 9 })) as typeof submitViaApiModule.lookupViaApi);

  await resumeCosigned(hook);

  expect(lookup).toHaveBeenCalledWith(INNER_HASH, "testnet");
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
  expect(useDemolishStore.getState().lastError).toBeNull();
});

test("a refused cosigned round not found by its inner hash is reported as failed", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  spyOn(submitViaApiModule, "submitViaApi").mockImplementation(async () => {
    throw new ApiRequestError(400, "tx_bad_seq");
  });
  spyOn(submitViaApiModule, "lookupViaApi").mockImplementation((async (hash: string) => ({
    status: "not_found",
    hash,
    searched: { latestLedger: 1, latestLedgerCloseTime: 0 },
  })) as unknown as typeof submitViaApiModule.lookupViaApi);

  await resumeCosigned(hook);

  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
});

test("discarding the round clears what was collected for it", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.discardCosignRound();
  });
  expect(hook.current.cosign).toBeNull();
  expect(hook.current.signatureStatus).toBeNull();
  let refusal = null as string | null;
  act(() => {
    refusal = hook.current.importCosignResponse(responseFrom(request, c));
  });
  expect(refusal).toMatch(/no paused step/);
});

test("a run with the master key on a merged round still re-reads the signers before sending", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  const added = {
    key: Keypair.random().publicKey(),
    weight: 1,
    type: "ed25519_public_key" as const,
  };
  readLive.mockImplementation(async () => liveAccount([...SIGNERS, added]));
  const signer = keySigner(master);

  await act(async () => {
    await hook.current.run(signer);
  });

  expect(signer.calls()).toBe(0);
  expect(readLive).toHaveBeenCalledTimes(1);
  expect(submitted).toHaveLength(0);
  expect(useDemolishStore.getState().lastError).toContain(COSIGN_REFUSED.signersChanged);
});

test("a merged round whose sequence was used is looked up by its inner hash before reporting", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  readLive.mockImplementation(async () => liveAccount([SIGNERS[0]!], "101"));
  const lookup = spyOn(submitViaApiModule, "lookupViaApi").mockImplementation((async (
    hash: string
  ) => ({ status: "confirmed", hash, ledger: 9 })) as typeof submitViaApiModule.lookupViaApi);

  await resumeCosigned(hook);

  expect(lookup).toHaveBeenCalledWith(INNER_HASH, "testnet");
  expect(submitted).toHaveLength(0);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
  expect(hook.current.signatureStatus).toBeNull();
});

test("a merged round refused by the live read and not found by its hash says the signers changed", async () => {
  const { hook, request } = await pausedOnMaster();
  act(() => {
    hook.current.importCosignResponse(responseFrom(request, b));
    hook.current.importCosignResponse(responseFrom(request, c));
  });
  readLive.mockImplementation(async () => liveAccount(SIGNERS, "101"));
  spyOn(submitViaApiModule, "lookupViaApi").mockImplementation((async (hash: string) => ({
    status: "not_found",
    hash,
    searched: { latestLedger: 1, latestLedgerCloseTime: 0 },
  })) as unknown as typeof submitViaApiModule.lookupViaApi);

  await resumeCosigned(hook);

  expect(useDemolishStore.getState().phase).toBe("STEP_FAILED");
  expect(useDemolishStore.getState().lastError).toContain(COSIGN_REFUSED.signersChanged);
});

test("a response is not added while a run is in progress", async () => {
  const { hook, request } = await pausedOnMaster();
  useDemolishStore.getState().setSigningRun(true);
  let refusal = null as string | null;
  act(() => {
    refusal = hook.current.importCosignResponse(responseFrom(request, b));
  });
  useDemolishStore.getState().setSigningRun(false);
  expect(refusal).toMatch(/Wait for the current step to finish/);
  expect(hook.current.cosign).toMatchObject({ collectedWeight: 1 });
});
