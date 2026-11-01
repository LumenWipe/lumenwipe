export interface FakeAnswer {
  status?: number;
  body?: unknown;
  /** The `Latest-Ledger` header; null leaves it out. */
  ledger?: number | null;
}

export interface FakeCall {
  host: string;
  path: string;
  headers: Record<string, string>;
}

/** A plain object rather than a `Response`, so reading it never yields to the event loop. */
function answer({ status = 200, body = {}, ledger = null }: FakeAnswer): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(ledger === null ? {} : { "Latest-Ledger": String(ledger) }),
    json: async () => body,
  } as unknown as Response;
}

/** One injected fetch shared by several synthetic hosts, recording who was asked what. */
export function fakeProviders(
  hosts: Record<string, (path: string, signal: AbortSignal) => FakeAnswer | Promise<FakeAnswer>>
): {
  fetch: typeof globalThis.fetch;
  calls: FakeCall[];
  callsOn: (host: string) => FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = `${url.pathname}${url.search}`;
    calls.push({
      host: url.hostname,
      path,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const handler = hosts[url.hostname];
    if (!handler) throw new Error(`unrouted host ${url.hostname}`);
    return answer(await handler(path, init!.signal!));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, callsOn: (host) => calls.filter((c) => c.host === host) };
}

/** Never answers; ends only when the attempt is aborted, like a hung connection. */
export const hang = (_path: string, signal: AbortSignal): Promise<FakeAnswer> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/**
 * Timers on a virtual clock, so a 40 second budget runs in milliseconds. Each timer fires on its
 * own turn of the event loop, in due order, once the work it could race has settled.
 */
export function fakeClock(budgetMs: number) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const controller = new AbortController();
  let now = 0;
  let nextId = 1;
  let pumping = false;

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    setImmediate(() => {
      pumping = false;
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      pump();
    });
  };
  const fakeSet = (fn: () => void, ms = 0): number => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
    pump();
    return id;
  };
  fakeSet(() => controller.abort(), budgetMs);
  globalThis.setTimeout = fakeSet as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof globalThis.clearTimeout;

  return {
    elapsed: () => now,
    deadline: {
      signal: controller.signal,
      remainingMs: () => Math.max(0, budgetMs - now),
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

export const after = async <T>(ms: number, value: T): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
};
