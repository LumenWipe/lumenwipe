import { afterEach, expect, spyOn, test } from "bun:test";
import { rpc } from "@stellar/stellar-sdk";
import { currentDeadline } from "@/common/request-context";
import { REQUEST_DEADLINE_MS } from "@/config/constants";
import { getRpcServer } from "@/lib/stellar/rpc";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import { inRequestContext } from "../support/request-context";
import {
  latestLedger,
  missingTransaction,
  sampleTransaction,
  sendResult,
  simulationError,
} from "../support/rpc-fixtures";

afterEach(() => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockRestore();
});

const never = (): Promise<never> => new Promise(() => {});
const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("every request gets a 40 second deadline", async () => {
  expect(REQUEST_DEADLINE_MS).toBe(40_000);
  const remaining = await inRequestContext(async () => currentDeadline()!.remainingMs());
  expect(remaining).toBeGreaterThan(39_000);
  expect(remaining).toBeLessThanOrEqual(40_000);
});

test("a read that outlives the request deadline rejects with a typed timeout", async () => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(never);
  const failure = await inRequestContext(() => getRpcServer("testnet").getLatestLedger(), 40).catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "timeout" });
});

test("reads and simulation run on separately configured instances, with this preserved", async () => {
  const owners: unknown[] = [];
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(function (this: unknown) {
    owners.push(this);
    return Promise.resolve(latestLedger(1));
  });
  const simulate = spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(function (
    this: unknown
  ) {
    owners.push(this);
    return Promise.resolve(simulationError());
  });
  try {
    const server = getRpcServer("testnet");
    await server.getLatestLedger();
    await server.simulateTransaction(sampleTransaction());
    expect(owners).toHaveLength(2);
    expect(owners.every((o) => o instanceof rpc.Server)).toBe(true);
    expect(owners[0]).not.toBe(owners[1]);
  } finally {
    simulate.mockRestore();
  }
});

test("sendTransaction is called once, never retried, and a failure is passed through as is", async () => {
  const boom = new Error("rpc down");
  const send = spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(boom);
  try {
    await expect(getRpcServer("testnet").sendTransaction(sampleTransaction())).rejects.toBe(boom);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
  }
});

test("a deadline that expires during a submit neither rejects the wrapper nor abandons it", async () => {
  const landed = sendResult("PENDING", "abc");
  const send = spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(() =>
    later(landed, 120)
  );
  try {
    const result = await inRequestContext(
      () => getRpcServer("testnet").sendTransaction(sampleTransaction()),
      30
    );
    expect(result).toBe(landed);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
  }
});

test("a method outside the allowlist passes through untouched, even past the deadline", async () => {
  const answer = missingTransaction("h");
  const hash = spyOn(rpc.Server.prototype, "pollTransaction").mockImplementation(() =>
    later(answer, 120)
  );
  try {
    const result = await inRequestContext(() => getRpcServer("testnet").pollTransaction("h"), 30);
    expect(result).toBe(answer);
  } finally {
    hash.mockRestore();
  }
});

test("a by-hash read stops waiting at the deadline", async () => {
  const hash = spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(() =>
    later(missingTransaction("h"), 120)
  );
  try {
    await expect(
      inRequestContext(() => getRpcServer("testnet").getTransaction("h"), 30)
    ).rejects.toBeInstanceOf(UpstreamError);
  } finally {
    hash.mockRestore();
  }
});

test("outside a request nothing is raced", async () => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(() =>
    later(latestLedger(7), 20)
  );
  expect(await getRpcServer("testnet").getLatestLedger()).toEqual(latestLedger(7));
});

test("simulation and preparation ask for legacy auth unless the caller says otherwise", async () => {
  const simulate = spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(
    simulationError()
  );
  const prepare = spyOn(rpc.Server.prototype, "prepareTransaction").mockResolvedValue(
    sampleTransaction()
  );
  try {
    const server = getRpcServer("testnet");
    const tx = sampleTransaction();
    await server.simulateTransaction(tx, { cpuInstructions: 5 });
    await server.simulateTransaction(tx, undefined, undefined, true);
    await server.prepareTransaction(tx);
    expect(simulate.mock.calls[0]).toEqual([tx, { cpuInstructions: 5 }, undefined, false]);
    expect(simulate.mock.calls[1]).toEqual([tx, undefined, undefined, true]);
    expect(prepare.mock.calls[0]).toEqual([tx, false]);
  } finally {
    simulate.mockRestore();
    prepare.mockRestore();
  }
});
