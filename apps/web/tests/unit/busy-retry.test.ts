import { expect, test } from "bun:test";
import { retryOnceWhenBusy, type BusyRetryOptions } from "@/lib/api/busy-retry";
import { ApiRequestError, busyRetryNotice } from "@/lib/utils/user-error";

const busy = (retryAfterSeconds?: number): ApiRequestError =>
  new ApiRequestError(503, "busy", undefined, "service_unavailable", retryAfterSeconds);

/** A call that answers each attempt in turn, counting them. */
function answers(...outcomes: (unknown | Error)[]): {
  call: () => Promise<string>;
  calls: () => number;
} {
  let n = 0;
  return {
    call: async () => {
      const outcome = outcomes[Math.min(n++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome as string;
    },
    calls: () => n,
  };
}

/** Records each wait instead of sleeping. */
function recordedSleep(): { waits: number[]; sleep: NonNullable<BusyRetryOptions["sleep"]> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

test("a busy answer is waited out for its Retry-After, then asked once more", async () => {
  const { call, calls } = answers(busy(3), "ok");
  const { waits, sleep } = recordedSleep();
  expect(await retryOnceWhenBusy(call, { sleep })).toBe("ok");
  expect(calls()).toBe(2);
  expect(waits).toEqual([3_000]);
});

test("a longer Retry-After is waited for 30 seconds at most", async () => {
  const { call } = answers(busy(600), "ok");
  const { waits, sleep } = recordedSleep();
  await retryOnceWhenBusy(call, { sleep });
  expect(waits).toEqual([30_000]);
});

test("a busy answer with no Retry-After it can read waits 5 seconds", async () => {
  const { call } = answers(busy(undefined), "ok");
  const { waits, sleep } = recordedSleep();
  await retryOnceWhenBusy(call, { sleep });
  expect(waits).toEqual([5_000]);
});

test.each([429, 400, 404, 500, 502, 504])("a %d is not asked again", async (status) => {
  const refused = new ApiRequestError(status, "no", undefined, undefined, 1);
  const { call, calls } = answers(refused, "ok");
  const { waits, sleep } = recordedSleep();
  await expect(retryOnceWhenBusy(call, { sleep })).rejects.toBe(refused);
  expect(calls()).toBe(1);
  expect(waits).toEqual([]);
});

test("a dropped connection is not asked again", async () => {
  const dropped = new TypeError("Failed to fetch");
  const { call, calls } = answers(dropped, "ok");
  await expect(retryOnceWhenBusy(call, { sleep: async () => {} })).rejects.toBe(dropped);
  expect(calls()).toBe(1);
});

test("a second busy answer is the one thrown, after exactly two calls", async () => {
  const second = busy(30);
  const { call, calls } = answers(busy(1), second, "ok");
  await expect(retryOnceWhenBusy(call, { sleep: async () => {} })).rejects.toBe(second);
  expect(calls()).toBe(2);
});

test("the wait is reported, then cleared once it is over", async () => {
  const { call } = answers(busy(7), "ok");
  const seen: (number | null)[] = [];
  await retryOnceWhenBusy(call, { sleep: async () => {}, onWait: (s) => void seen.push(s) });
  expect(seen).toEqual([7, null]);
});

test.each(["signal", "stop"] as const)(
  "a wait ended by its %s answers with the busy reply that started it, and asks nothing more",
  async (which) => {
    const first = busy(30);
    const { call, calls } = answers(first, "ok");
    const ender = new AbortController();
    const seen: (number | null)[] = [];
    const pending = retryOnceWhenBusy(call, { [which]: ender.signal, onWait: (s) => seen.push(s) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ender.abort();
    await expect(pending).rejects.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls()).toBe(1);
    expect(seen).toEqual([30, null]);
  }
);

test("a request already left does not wait", async () => {
  const first = busy(30);
  const { call, calls } = answers(first, "ok");
  const left = new AbortController();
  left.abort();
  const { waits, sleep } = recordedSleep();
  await expect(retryOnceWhenBusy(call, { signal: left.signal, sleep })).rejects.toBe(first);
  expect(calls()).toBe(1);
  expect(waits).toEqual([]);
});

test("a retry cut off by leaving answers with the busy reply, not the cut-off", async () => {
  const first = busy(0);
  const left = new AbortController();
  let n = 0;
  const call = async (): Promise<string> => {
    if (n++ === 0) throw first;
    left.abort();
    throw new DOMException("aborted", "AbortError");
  };
  await expect(retryOnceWhenBusy(call, { signal: left.signal })).rejects.toBe(first);
});

test("the notice keeps the busy copy and says when the page asks again", () => {
  expect(busyRetryNotice(30)).toBe(
    "The service LumenWipe reads the Stellar network through is busy or not answering right now. This is not a problem with your connection. LumenWipe will try again on its own in about 30 seconds."
  );
  expect(busyRetryNotice(1)).toEndWith("in about 1 second.");
  expect(busyRetryNotice(0)).toEndWith("on its own now.");
});
