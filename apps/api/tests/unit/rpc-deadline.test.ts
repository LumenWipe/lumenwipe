import { afterEach, expect, spyOn, test } from "bun:test";
import { rpc } from "@stellar/stellar-sdk";
import { currentDeadline, requestContextMiddleware } from "@/common/request-context";
import { REQUEST_DEADLINE_MS } from "@/config/constants";
import { getRpcServer } from "@/lib/stellar/rpc";
import { UpstreamError } from "@/lib/stellar/upstream-client";

afterEach(() => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockRestore();
});

function inRequest<T>(deadlineMs: number | undefined, run: () => Promise<T>): Promise<T> {
  const req = { path: "/x" };
  const res = { setHeader() {}, json() {}, on() {} };
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware(deadlineMs)(req as never, res as never, () => {
      run().then(resolve, reject);
    })
  );
}

const never = (): Promise<never> => new Promise(() => {});
const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("every request gets a 40 second deadline", async () => {
  expect(REQUEST_DEADLINE_MS).toBe(40_000);
  const remaining = await inRequest(undefined, async () => currentDeadline()!.remainingMs());
  expect(remaining).toBeGreaterThan(39_000);
  expect(remaining).toBeLessThanOrEqual(40_000);
});

test("a read that outlives the request deadline rejects with a typed timeout", async () => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(never);
  const failure = await inRequest(40, () => getRpcServer("testnet").getLatestLedger()).catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "timeout" });
});

test("reads and simulation run on separately configured instances, with this preserved", async () => {
  const owners: unknown[] = [];
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(function (this: unknown) {
    owners.push(this);
    return Promise.resolve({ sequence: 1 } as never);
  });
  const simulate = spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(function (
    this: unknown
  ) {
    owners.push(this);
    return Promise.resolve({} as never);
  });
  try {
    const server = getRpcServer("testnet");
    await server.getLatestLedger();
    await server.simulateTransaction({} as never);
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
    await expect(getRpcServer("testnet").sendTransaction({} as never)).rejects.toBe(boom);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
  }
});

test("a deadline that expires during a submit neither rejects the wrapper nor abandons it", async () => {
  const landed = { status: "PENDING", hash: "abc" };
  const send = spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(() =>
    later(landed as never, 120)
  );
  try {
    const result = await inRequest(30, () => getRpcServer("testnet").sendTransaction({} as never));
    expect(result).toBe(landed as never);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
  }
});

test("a method outside the allowlist passes through untouched, even past the deadline", async () => {
  const hash = spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(() =>
    later({ status: "SUCCESS" } as never, 120)
  );
  try {
    const result = await inRequest(30, () => getRpcServer("testnet").getTransaction("h"));
    expect(result).toEqual({ status: "SUCCESS" } as never);
  } finally {
    hash.mockRestore();
  }
});

test("outside a request nothing is raced", async () => {
  spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(() =>
    later({ sequence: 7 } as never, 20)
  );
  expect(await getRpcServer("testnet").getLatestLedger()).toEqual({ sequence: 7 } as never);
});
