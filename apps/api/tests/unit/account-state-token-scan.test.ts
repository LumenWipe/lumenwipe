import { afterEach, expect, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { DefiPositionsResult, SorobanTokensResult } from "@lumenwipe/types";
import { readAccountStateFrom, type AccountReadOptions } from "@/lib/stellar/account-state";
import * as resolveModule from "@/lib/defi-positions/resolve-defi-positions";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { fakeSorobanDeps } from "./fixtures/fake-soroban-tokens";
import { fakeFetch } from "../support/fetch";
import { healthAnswer } from "../support/rpc-fixtures";

const ADDRESS = Keypair.random().publicKey();
const NO_DEFI: ResolveDefiPositionsDeps = {
  octopos: { baseUrl: "" },
  directRead: { registryEntries: [] },
};

/** A Horizon-compatible provider; with `offersStatus`, the offers read fails after the account
 *  body has been read, so detection has started by the time the snapshot rejects. */
const horizonWith = (offersStatus?: number) => ({
  baseUrl: "https://horizon.example",
  fetch: fakeFetch(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (offersStatus !== undefined && url.includes("/offers")) {
      return new Response("{}", { status: offersStatus });
    }
    const body =
      url.includes("/offers") || url.includes("/claimable_balances")
        ? { _embedded: { records: [] } }
        : {
            sequence: "42",
            subentry_count: 0,
            thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
            signers: [{ key: ADDRESS, weight: 1, type: "ed25519_public_key" }],
            balances: [{ asset_type: "native", balance: "100.0000000" }],
            data: {},
            flags: { auth_immutable: false },
            num_sponsoring: 0,
          };
    return new Response(JSON.stringify(body), { status: 200 });
  }),
});

const horizon = horizonWith();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Detection and the scan's first RPC read, each held until the test lets it go. `scanStarted`
 * resolves when the scan asks for the latest ledger.
 */
function heldRead(scanEvents = true) {
  const detection = deferred<DefiPositionsResult>();
  const scanLedger = deferred<ReturnType<typeof healthAnswer>>();
  const scanStarted = deferred<void>();
  spyOn(resolveModule, "resolveDefiPositions").mockImplementation(() => detection.promise);
  const tokens = fakeSorobanDeps({ world: { tokens: [] }, listCandidates: [] });
  tokens.scanEvents = scanEvents;
  tokens.rpc.getHealth = () => {
    scanStarted.resolve();
    return scanLedger.promise;
  };
  const options: AccountReadOptions = {
    ledgerCloseTime: () => Promise.resolve(null),
    sorobanTokensDeps: () => tokens,
  };
  const read = readAccountStateFrom(ADDRESS, "testnet", horizon, NO_DEFI, options);
  return { read, detection, scanLedger, scanStarted, tokens };
}

async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await settle();
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

afterEach(() => {
  spyOn(resolveModule, "resolveDefiPositions").mockRestore();
});

test("the event scan starts while DeFi detection is still running", async () => {
  const held = heldRead();
  await held.scanStarted.promise;
  held.detection.resolve(emptyDefiPositionsResult(ADDRESS));
  held.scanLedger.resolve(healthAnswer(1_000_000));
  const state = await held.read;
  expect(held.tokens.rpc.eventRequests).toHaveLength(1);
  expect(state.sorobanTokens?.coverage).toContainEqual({ source: "events", status: "ok" });
});

test("a read that does not ask for the event scan never starts it", async () => {
  const held = heldRead(false);
  held.detection.resolve(emptyDefiPositionsResult(ADDRESS));
  const state = await held.read;
  held.scanLedger.resolve(healthAnswer(1_000_000));
  await settle();
  expect(held.tokens.rpc.eventRequests).toEqual([]);
  expect(state.sorobanTokens?.coverage).toContainEqual({
    source: "events",
    status: "skipped",
    detail: "not requested",
  });
});

test("a failed scan ends the same whether it fails before or after detection", async () => {
  const outcomes: (SorobanTokensResult | undefined)[] = [];
  for (const scanFailsFirst of [true, false]) {
    const unhandled = await unhandledDuring(async () => {
      const held = heldRead();
      await held.scanStarted.promise;
      if (scanFailsFirst) {
        held.scanLedger.reject(new Error("down"));
        await settle();
        held.detection.resolve(emptyDefiPositionsResult(ADDRESS));
      } else {
        held.detection.resolve(emptyDefiPositionsResult(ADDRESS));
        await settle();
        held.scanLedger.reject(new Error("down"));
      }
      outcomes.push((await held.read).sorobanTokens);
    });
    expect(unhandled).toEqual([]);
  }
  expect(outcomes[0]).toEqual(outcomes[1]);
  expect(outcomes[0]?.coverage).toContainEqual({
    source: "events",
    status: "failed",
    detail: "down",
  });
  expect(outcomes[0]?.eventsScanned).toBeNull();
});

test("a detection failure fails the read whether the scan is in flight or already failed", async () => {
  for (const scanFailsFirst of [false, true]) {
    const failure = new UpstreamError("unavailable", "defi");
    let outcome: unknown;
    const unhandled = await unhandledDuring(async () => {
      const held = heldRead();
      await held.scanStarted.promise;
      if (scanFailsFirst) {
        held.scanLedger.reject(new Error("down"));
        await settle();
      }
      held.detection.reject(failure);
      outcome = await held.read.catch((e: unknown) => e);
      if (!scanFailsFirst) held.scanLedger.reject(new Error("down"));
    });
    expect(outcome).toBe(failure);
    expect(unhandled).toEqual([]);
  }
});

test("a token deps factory that throws while the snapshot read fails leaves only the read's error", async () => {
  spyOn(resolveModule, "resolveDefiPositions").mockResolvedValue(emptyDefiPositionsResult(ADDRESS));
  const throwing: AccountReadOptions = {
    ledgerCloseTime: () => Promise.resolve(null),
    sorobanTokensDeps: () => {
      throw new Error("no deps today");
    },
  };
  const read = (options: AccountReadOptions) =>
    readAccountStateFrom(ADDRESS, "testnet", horizonWith(400), NO_DEFI, options).catch(
      (e: unknown) => e
    );
  const expected = await read({ ledgerCloseTime: () => Promise.resolve(null) });
  expect(expected).toBeInstanceOf(Error);
  let failure: unknown;
  const unhandled = await unhandledDuring(async () => {
    failure = await read(throwing);
  });
  expect(failure).toEqual(expected);
  expect((failure as Error).message).not.toContain("no deps today");
  expect(unhandled).toEqual([]);
});

test("a token deps factory that throws on a read that succeeds ends in the partial-token warning", async () => {
  const detection = deferred<DefiPositionsResult>();
  spyOn(resolveModule, "resolveDefiPositions").mockImplementation(() => detection.promise);
  let state: Awaited<ReturnType<typeof readAccountStateFrom>> | undefined;
  const unhandled = await unhandledDuring(async () => {
    const read = readAccountStateFrom(ADDRESS, "testnet", horizon, NO_DEFI, {
      ledgerCloseTime: () => Promise.resolve(null),
      sorobanTokensDeps: () => {
        throw new Error("no deps today");
      },
    });
    await settle();
    detection.resolve(emptyDefiPositionsResult(ADDRESS));
    state = await read;
  });
  expect(unhandled).toEqual([]);
  expect(state?.sorobanTokens).toMatchObject({
    tokens: [],
    unreadable: [],
    coverage: [],
    eventsScanned: null,
  });
  expect(state?.sorobanTokens?.warnings).toEqual([
    expect.objectContaining({ code: "soroban_tokens_partial" }),
  ]);
  expect(state?.sorobanTokens?.warnings[0]?.message).toContain("no deps today");
});
