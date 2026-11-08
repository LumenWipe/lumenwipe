import { expect, spyOn, test } from "bun:test";
import {
  LumenWipeClient,
  LumenWipeIntegratorClient,
  LumenWipeTimeoutError,
  type FetchLike,
} from "../../src/index";
import { DEFAULT_TIMEOUT_MS } from "../../src/http";

/** Never answers, and rejects like real fetch once the signal aborts. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (init?.signal?.aborted) return abort();
    init?.signal?.addEventListener("abort", abort);
  });

const CLIENTS: [string, (timeout?: number) => Promise<unknown>][] = [
  [
    "LumenWipeClient",
    (timeout) =>
      new LumenWipeClient({
        baseUrl: "https://x",
        apiKey: "k",
        network: "testnet",
        fetch: hangingFetch,
        ...(timeout !== undefined && { timeout }),
      }).getAccount("GABC"),
  ],
  [
    "LumenWipeIntegratorClient",
    (timeout) =>
      new LumenWipeIntegratorClient({
        baseUrl: "https://x",
        fetch: hangingFetch,
        ...(timeout !== undefined && { timeout }),
      }).listKeys("lws.token"),
  ],
];

const timeoutOf = (request: Promise<unknown>): Promise<unknown> =>
  request.then(
    () => undefined,
    (e: unknown) => e
  );

test.each(CLIENTS)("%s waits the default timeout when none is given", async (_name, request) => {
  const delays: unknown[] = [];
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    run: () => void,
    ms?: number
  ) => {
    delays.push(ms);
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout);
  const error = await timeoutOf(request()).finally(() => timers.mockRestore());
  expect(error).toBeInstanceOf(LumenWipeTimeoutError);
  expect((error as LumenWipeTimeoutError).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  expect(delays).toEqual([DEFAULT_TIMEOUT_MS]);
});

test.each(CLIENTS)("%s honors an explicit timeout", async (_name, request) => {
  const error = await timeoutOf(request(10));
  expect(error).toBeInstanceOf(LumenWipeTimeoutError);
  expect((error as LumenWipeTimeoutError).timeoutMs).toBe(10);
});
