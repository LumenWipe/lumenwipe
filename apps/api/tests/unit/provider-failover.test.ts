import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { requestContextMiddleware } from "@/common/request-context";
import {
  HORIZON_FALLBACKS,
  PATH_ROUTING_API_HEADERS,
  PATH_ROUTING_API_URLS,
} from "@/config/networks";
import { assessIssuance, defaultIssuanceDeps } from "@/lib/close-api/issuance-preflight";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import {
  readAccountStateFrom,
  readNativeBalance,
  readTrustlinesOnly,
  type AccountReadOptions,
} from "@/lib/stellar/account-state";
import type { HorizonDeps } from "@/lib/stellar/horizon-http";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import {
  isRetryableProviderFailure,
  pinHorizonSource,
  pinnedHorizonSource,
  providerFailoverCount,
  resetProviderFailoverCount,
  withHorizonFailover,
} from "@/lib/stellar/provider-failover";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import { fetchOwnerLiveStatesBounded } from "@/lib/stellar/sponsorship";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import {
  AccountNotFoundError,
  AccountStateChangedError,
  UnusableProviderResponseError,
} from "@/lib/utils/errors";
import { OFFLINE_SOROBAN_TOKENS } from "./fixtures/fake-soroban-tokens";
import { after, fakeClock, fakeProviders, hang, type FakeAnswer } from "./fixtures/fake-providers";

const ADDRESS = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const NO_DEFI: ResolveDefiPositionsDeps = {
  octopos: { baseUrl: "" },
  directRead: { registryEntries: [] },
};
const REFERENCE = 110;

function accountBody(over: Record<string, unknown> = {}) {
  return {
    sequence: "42",
    subentry_count: 0,
    thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: ADDRESS, weight: 1, type: "ed25519_public_key" }],
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    data: {},
    flags: { auth_immutable: false },
    num_sponsoring: 0,
    ...over,
  };
}

const EMPTY_PAGE = { _embedded: { records: [] } };

/** A conforming provider at `ledger`, with `/operations` carrying no header, like the real one. */
function healthy(ledger: number, over: Record<string, unknown> = {}) {
  return (path: string): FakeAnswer => {
    if (path.includes("/operations")) return { body: EMPTY_PAGE, ledger: null };
    if (path.includes("/offers") || path.includes("/claimable_balances")) {
      return { body: EMPTY_PAGE, ledger };
    }
    return { body: accountBody(over), ledger };
  };
}

const down = (): FakeAnswer => ({ status: 500 });

function chain(fetch: typeof globalThis.fetch, ...hosts: string[]): HorizonDeps[] {
  return hosts.map((host) => ({
    baseUrl: `https://${host}`,
    fetch,
    client: { policy: { maxRetries: 0 }, random: () => 0 },
  }));
}

function read(deps: HorizonDeps[], over: AccountReadOptions = {}) {
  return readAccountStateFrom(ADDRESS, "testnet", deps[0]!, NO_DEFI, {
    ...OFFLINE_SOROBAN_TOKENS,
    fallbacks: deps.slice(1),
    referenceLedger: async () => REFERENCE,
    ledgerCloseTime: async () => 1_700_000_000,
    ...over,
  });
}

function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const res = { setHeader() {}, json() {}, on() {} };
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware()({ path: "/x" } as never, res as never, () => {
      run().then(resolve, reject);
    })
  );
}

const realPrimary = PATH_ROUTING_API_URLS.testnet;
const realFallbacks = HORIZON_FALLBACKS.testnet;
const realHeaders = PATH_ROUTING_API_HEADERS.testnet;

beforeEach(() => resetProviderFailoverCount());
afterEach(() => {
  PATH_ROUTING_API_URLS.testnet = realPrimary;
  HORIZON_FALLBACKS.testnet = realFallbacks;
  PATH_ROUTING_API_HEADERS.testnet = realHeaders;
});

test("a snapshot is one provider's: a partial read on A never counts in B's span", async () => {
  const fake = fakeProviders({
    a: (path) => (path.includes("/offers") ? down() : healthy(100)(path)),
    b: healthy(110),
  });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(state.snapshotLedger).toBe(110);
  expect(fake.callsOn("b").filter((c) => c.path === `/accounts/${ADDRESS}`)).toHaveLength(1);
  expect(providerFailoverCount()).toBe(1);
});

test("every read of the round, sponsorship included, lands on the winning provider", async () => {
  const fake = fakeProviders({
    a: down,
    b: healthy(110, { num_sponsoring: 1 }),
  });
  PATH_ROUTING_API_URLS.testnet = "https://a";
  const [a, b] = chain(fake.fetch, "a", "b");
  const state = await read([a!, { ...b!, headers: { "x-key": "synthetic-b" } }]);
  const onA = fake.callsOn("a");
  expect(onA).toHaveLength(1);
  expect(onA[0]!.path).toBe(`/accounts/${ADDRESS}`);
  const onB = fake.callsOn("b").map((c) => c.path);
  expect(onB.some((p) => p.includes("/operations"))).toBe(true);
  expect(onB.some((p) => p.includes("sponsor="))).toBe(true);
  expect(state.sponsorshipEnumerationIncomplete).toBe(true);
});

test("a later read of the same request stays on the provider of the snapshot", async () => {
  const owner = Keypair.random().publicKey();
  const fake = fakeProviders({ a: down, b: healthy(110) });
  PATH_ROUTING_API_URLS.testnet = "https://a";
  const saved = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    await inRequest(async () => {
      await read(chain(fake.fetch, "a", "b"));
      await fetchOwnerLiveStatesBounded([owner], "testnet");
    });
  } finally {
    globalThis.fetch = saved;
  }
  expect(fake.callsOn("a")).toHaveLength(1);
  expect(fake.callsOn("b").some((c) => c.path === `/accounts/${owner}`)).toBe(true);
});

test("a primary answering without subentry_count fails over to a conforming provider", async () => {
  const fake = fakeProviders({
    a: healthy(110, { subentry_count: undefined }),
    b: healthy(110),
  });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(state.numSubEntries).toBe(0);
  expect(fake.callsOn("b").length).toBeGreaterThan(0);
});

test("a primary answering without flags fails over to a conforming provider", async () => {
  const fake = fakeProviders({ a: healthy(110, { flags: undefined }), b: healthy(110) });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(state.authImmutable).toBe(false);
  expect(fake.callsOn("b").length).toBeGreaterThan(0);
});

test("a lagging provider is an outage on the next one's behalf, not a change", async () => {
  const fake = fakeProviders({ a: healthy(100), b: healthy(109) });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(state.snapshotLedger).toBe(109);
});

test("lag at the tolerance passes and one ledger past it does not", async () => {
  const atTolerance = fakeProviders({ a: healthy(REFERENCE - 2), b: down });
  expect((await read(chain(atTolerance.fetch, "a", "b"))).snapshotLedger).toBe(REFERENCE - 2);
  const past = fakeProviders({ a: healthy(REFERENCE - 3), b: healthy(REFERENCE) });
  expect((await read(chain(past.fetch, "a", "b"))).snapshotLedger).toBe(REFERENCE);
});

test("lag across every provider is unavailable, never state_changed", async () => {
  const fake = fakeProviders({ a: healthy(100), b: healthy(101) });
  const failure = await read(chain(fake.fetch, "a", "b")).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "unavailable" });
});

test("a lagging provider whose reads also span ledgers is judged on lag first", async () => {
  const spanning = (path: string): FakeAnswer => {
    const ledger = path.includes("/offers") ? 104 : 100;
    return healthy(ledger)(path);
  };
  const fake = fakeProviders({ a: spanning, b: spanning });
  const failure = await read(chain(fake.fetch, "a", "b")).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).not.toBeInstanceOf(AccountStateChangedError);
  expect(fake.calls.filter((c) => c.path === `/accounts/${ADDRESS}`)).toHaveLength(2);
});

test("a snapshot response with no Latest-Ledger is unavailable, when failover is configured", async () => {
  const headerless = (path: string): FakeAnswer => ({ ...healthy(110)(path), ledger: null });
  const fake = fakeProviders({ a: headerless, b: healthy(110) });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(state.snapshotLedger).toBe(110);
});

test("a header missing from one collection counts as much as one missing from all", async () => {
  const fake = fakeProviders({
    a: (path) => (path.includes("/offers") ? { body: EMPTY_PAGE } : healthy(110)(path)),
    b: healthy(110),
  });
  await read(chain(fake.fetch, "a", "b"));
  expect(fake.callsOn("b").length).toBeGreaterThan(0);
});

test("/operations without Latest-Ledger is neither a lag verdict nor a failover", async () => {
  const sponsoredBalance = {
    id: "00".repeat(36),
    asset: "native",
    amount: "1.0000000",
    sponsor: ADDRESS,
    last_modified_time: "2026-01-01T00:00:00Z",
    claimants: [{ destination: ISSUER, predicate: { unconditional: true } }],
  };
  const sponsoring = healthy(110, { num_sponsoring: 1 });
  const fake = fakeProviders({
    a: (path) =>
      path.includes("sponsor=")
        ? { body: { _embedded: { records: [sponsoredBalance] } }, ledger: 110 }
        : sponsoring(path),
    b: healthy(110),
  });
  const state = await read(chain(fake.fetch, "a", "b"));
  expect(fake.callsOn("a").some((c) => c.path.includes("/operations"))).toBe(true);
  expect(fake.callsOn("b")).toHaveLength(0);
  expect(providerFailoverCount()).toBe(0);
  expect(state.snapshotLedger).toBe(110);
  expect(state.sponsorshipEnumerationIncomplete).toBe(false);
  expect(state.sponsoredEntries).toHaveLength(1);
});

test("a state change seen by a fresh provider is terminal: the next one is never asked", async () => {
  const moving = (path: string): FakeAnswer => {
    const ledger = path.includes("/offers") ? 120 : 110;
    return healthy(ledger)(path);
  };
  const fake = fakeProviders({ a: moving, b: healthy(120) });
  const failure = await read(chain(fake.fetch, "a", "b")).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(AccountStateChangedError);
  expect(fake.callsOn("b")).toHaveLength(0);
});

test("a primary's 404 is the answer and the next provider is never asked", async () => {
  const fake = fakeProviders({ a: () => ({ status: 404 }), b: healthy(110) });
  await expect(read(chain(fake.fetch, "a", "b"))).rejects.toBeInstanceOf(AccountNotFoundError);
  const deps = chain(fake.fetch, "a", "b");
  await expect(
    readNativeBalance(ADDRESS, "testnet", deps[0]!, deps.slice(1))
  ).rejects.toBeInstanceOf(AccountNotFoundError);
  expect(await readTrustlinesOnly(ADDRESS, "testnet", deps[0]!, deps.slice(1))).toBeNull();
  expect(fake.callsOn("b")).toHaveLength(0);
});

test("a lone provider's 404 is the answer", async () => {
  const fake = fakeProviders({ a: () => ({ status: 404 }) });
  const [lone] = chain(fake.fetch, "a");
  expect(await readTrustlinesOnly(ADDRESS, "testnet", lone, [])).toBeNull();
});

test("the last provider keeps its own retries", async () => {
  let answered = 0;
  const fake = fakeProviders({
    a: down,
    b: () => (++answered === 1 ? down() : { body: accountBody() }),
  });
  const a = chain(fake.fetch, "a")[0]!;
  const b: HorizonDeps = {
    baseUrl: "https://b",
    fetch: fake.fetch,
    client: { policy: { maxRetries: 1 }, random: () => 0, sleep: async () => undefined },
  };
  const result = await readNativeBalance(ADDRESS, "testnet", a, [b]);
  expect(result.nativeBalanceLumens).toBe("100.0000000");
  expect(answered).toBe(2);
});

test("a failover is a counter and a structured line naming hostnames, nothing more", async () => {
  const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  try {
    const fake = fakeProviders({
      a: () => ({ status: 429 }),
      b: healthy(110, { flags: undefined }),
      c: healthy(110),
    });
    const deps = ["a.test/synthetic-key", "b.test/synthetic-key", "c.test"].map((base) => ({
      baseUrl: `https://${base}`,
      fetch: (async (input: string, init: RequestInit) =>
        fake.fetch(
          input.replace(/\.test\/synthetic-key|\.test/, ""),
          init
        )) as typeof globalThis.fetch,
      client: { policy: { maxRetries: 0 } },
    }));
    await read(deps);
    const lines = warn.mock.calls.map((call) => call[0] as { message: string });
    expect(lines.filter((line) => line.message === "provider failover")).toEqual([
      {
        message: "provider failover",
        kind: "horizon",
        network: "testnet",
        from: "a.test",
        to: "b.test",
        reason: "rate_limited",
      },
      {
        message: "provider failover",
        kind: "horizon",
        network: "testnet",
        from: "b.test",
        to: "c.test",
        reason: "unusable_response",
      },
    ] as never);
    expect(providerFailoverCount()).toBe(2);
  } finally {
    warn.mockRestore();
  }
});

test("the snapshot's provider is remembered per network and per request", async () => {
  const source = { baseUrl: "https://b" };
  expect(
    await inRequest(async () => {
      pinHorizonSource("testnet", source);
      return [pinnedHorizonSource("testnet"), pinnedHorizonSource("mainnet")];
    })
  ).toEqual([source, undefined]);
  expect(pinnedHorizonSource("testnet")).toBeUndefined();
});

test("a fallback's 404 is unavailable, never account-not-found", async () => {
  const fake = fakeProviders({ a: down, b: () => ({ status: 404 }) });
  const deps = chain(fake.fetch, "a", "b");
  for (const attempt of [
    read(deps),
    readNativeBalance(ADDRESS, "testnet", deps[0]!, deps.slice(1)),
    readTrustlinesOnly(ADDRESS, "testnet", deps[0]!, deps.slice(1)),
  ]) {
    const failure = await attempt.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ kind: "unavailable" });
  }
});

test("every provider failing is the typed unavailable, whatever each one's fault was", async () => {
  const fake = fakeProviders({
    a: () => ({ status: 429 }),
    b: healthy(110, { flags: undefined }),
  });
  const failure = await read(chain(fake.fetch, "a", "b")).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "unavailable" });
});

test("a lone provider behaves as it always did: no reference, and its faults come back as they are", async () => {
  let referenced = 0;
  const lone = fakeProviders({ a: healthy(100, { flags: undefined }) });
  const failure = await read(chain(lone.fetch, "a"), {
    referenceLedger: async () => {
      referenced++;
      return 500;
    },
  }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(UnusableProviderResponseError);
  expect(referenced).toBe(0);
});

test("a lagging lone provider still ends in the existing state_changed", async () => {
  const moving = (path: string): FakeAnswer => {
    const ledger = path.includes("/offers") ? 104 : 100;
    return healthy(ledger)(path);
  };
  const fake = fakeProviders({ a: moving });
  await expect(read(chain(fake.fetch, "a"))).rejects.toBeInstanceOf(AccountStateChangedError);
  expect(providerFailoverCount()).toBe(0);
});

test("detection waits for the first good body and does not run again on a restart", async () => {
  let started = 0;
  const fake = fakeProviders({
    a: (path) => (path.includes("/offers") ? down() : healthy(110)(path)),
    b: healthy(110),
  });
  await read(chain(fake.fetch, "a", "b"), {
    ledgerCloseTime: async () => {
      started++;
      return 1;
    },
  });
  expect(started).toBe(1);
});

test("detection does not start while no provider has produced a body", async () => {
  let started = 0;
  const fake = fakeProviders({ a: down, b: down });
  await read(chain(fake.fetch, "a", "b"), {
    ledgerCloseTime: async () => {
      started++;
      return 1;
    },
  }).catch(() => undefined);
  expect(started).toBe(0);
});

test("a detection failure is the read's failure and restarts nothing", async () => {
  const fake = fakeProviders({ a: healthy(110), b: healthy(110) });
  const boom = new UpstreamError("unavailable", "defi");
  const failure = await read(chain(fake.fetch, "a", "b"), {
    ledgerCloseTime: async () => {
      throw boom;
    },
  }).catch((e: unknown) => e);
  expect(failure).toBe(boom);
  expect(fake.callsOn("b")).toHaveLength(0);
});

test("a detection rejecting after the read already failed is never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    const fake = fakeProviders({
      a: (path) => (path.includes("/offers") ? down() : healthy(110)(path)),
      b: down,
    });
    const failure = await read(chain(fake.fetch, "a", "b"), {
      ledgerCloseTime: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("late detection failure");
      },
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("each provider gets its own headers and no other's", async () => {
  const fake = fakeProviders({ a: down, b: healthy(110) });
  const [a, b] = chain(fake.fetch, "a", "b");
  await read([
    { ...a!, headers: { "x-key": "synthetic-a" } },
    { ...b!, headers: { "x-other": "synthetic-b" } },
  ]);
  expect(fake.callsOn("a")[0]!.headers["x-key"]).toBe("synthetic-a");
  for (const call of fake.callsOn("b")) {
    expect(call.headers["x-key"]).toBeUndefined();
    expect(call.headers["x-other"]).toBe("synthetic-b");
  }
});

test("the allowlist admits outages and non-conformance and nothing else", () => {
  for (const kind of ["rate_limited", "timeout", "unavailable", "bad_response"] as const) {
    expect(isRetryableProviderFailure(new UpstreamError(kind, "horizon"))).toBe(true);
  }
  expect(isRetryableProviderFailure(new UnusableProviderResponseError(ADDRESS, ["x"]))).toBe(true);
  expect(isRetryableProviderFailure(new AccountStateChangedError("moved"))).toBe(false);
  expect(isRetryableProviderFailure(new TruncatedCollectionError("big"))).toBe(false);
  expect(isRetryableProviderFailure(new AccountNotFoundError(ADDRESS))).toBe(false);
  expect(isRetryableProviderFailure(new Error("anything else"))).toBe(false);
});

test("an unclassified failure is rethrown as is and asks nobody else", async () => {
  const boom = new Error("a bug, not an outage");
  let reads = 0;
  const failure = await withHorizonFailover(
    "testnet",
    { baseUrl: "https://a" },
    [{ baseUrl: "https://b" }],
    async () => {
      reads++;
      throw boom;
    }
  ).catch((e: unknown) => e);
  expect(failure).toBe(boom);
  expect(reads).toBe(1);
});

test("no provider is asked once the request's budget is gone", async () => {
  const controller = new AbortController();
  const deadline = { signal: controller.signal, remainingMs: () => 0 };
  const asked: string[] = [];
  const failure = await withHorizonFailover(
    "testnet",
    { baseUrl: "https://a", deadline },
    [{ baseUrl: "https://b" }],
    async (attempt) => {
      asked.push(attempt.baseUrl);
      controller.abort();
      throw new UpstreamError("timeout", "horizon");
    }
  ).catch((e: unknown) => e);
  expect(asked).toEqual(["https://a"]);
  expect(failure).toMatchObject({ kind: "unavailable" });
});

test("budget: a hung primary gets one attempt, and a third provider answers inside 40 s", async () => {
  const clock = fakeClock(40_000);
  try {
    const fake = fakeProviders({
      a: hang,
      b: hang,
      c: () => after(1_000, { body: accountBody(), ledger: 110 }),
    });
    const deps = ["a", "b", "c"].map((host) => ({
      baseUrl: `https://${host}`,
      fetch: fake.fetch,
      deadline: clock.deadline,
    }));
    const result = await readNativeBalance(ADDRESS, "testnet", deps[0]!, deps.slice(1));
    expect(result.nativeBalanceLumens).toBe("100.0000000");
    expect(fake.callsOn("a")).toHaveLength(1);
    expect(fake.callsOn("b")).toHaveLength(1);
    expect(clock.elapsed()).toBeLessThan(40_000);
  } finally {
    clock.restore();
  }
});

test("budget: a short remainder is split, so the provider after a hung one still gets its share", async () => {
  const clock = fakeClock(12_000);
  try {
    const fake = fakeProviders({
      a: hang,
      b: () => after(5_000, { body: accountBody(), ledger: 110 }),
    });
    const deps = ["a", "b"].map((host) => ({
      baseUrl: `https://${host}`,
      fetch: fake.fetch,
      deadline: clock.deadline,
    }));
    const result = await readNativeBalance(ADDRESS, "testnet", deps[0]!, deps.slice(1));
    expect(result.nativeBalanceLumens).toBe("100.0000000");
    expect(clock.elapsed()).toBe(11_000);
  } finally {
    clock.restore();
  }
});

test("budget: the failover policy wins over the issuance read's own retries", async () => {
  const clock = fakeClock(40_000);
  const records = { _embedded: { records: [] } };
  const fake = fakeProviders({
    a: hang,
    b: () => after(500, { body: records, ledger: 110 }),
  });
  PATH_ROUTING_API_URLS.testnet = "https://a";
  HORIZON_FALLBACKS.testnet = [{ url: "https://b", headers: {} }];
  try {
    const live = defaultIssuanceDeps();
    const bound = (deps: HorizonDeps): HorizonDeps => ({
      ...deps,
      fetch: fake.fetch,
      deadline: clock.deadline,
    });
    const summary = await assessIssuance(ADDRESS, "testnet", {
      horizon: (network) => bound(live.horizon(network)),
      fallbacks: (network) => live.fallbacks!(network).map(bound),
    });
    expect(summary).toBeNull();
    expect(fake.callsOn("a")).toHaveLength(1);
    expect(fake.callsOn("b")).toHaveLength(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(4_500);
  } finally {
    clock.restore();
  }
});

test("conversion paths fail over too, with each provider's own headers", async () => {
  const fake = fakeProviders({
    a: down,
    b: () => ({
      body: { _embedded: { records: [{ destination_amount: "1.0000000", path: [] }] } },
    }),
  });
  PATH_ROUTING_API_URLS.testnet = "https://a";
  PATH_ROUTING_API_HEADERS.testnet = { "x-key": "synthetic-a" };
  HORIZON_FALLBACKS.testnet = [{ url: "https://b", headers: { "x-other": "synthetic-b" } }];
  const result = await fetchConversionPath(`USDC:${ISSUER}`, "1", "testnet", "native", {
    fetch: fake.fetch,
    client: { policy: { maxRetries: 0 } },
  });
  expect(result.kind).toBe("route");
  expect(fake.callsOn("a")[0]!.headers["x-key"]).toBe("synthetic-a");
  expect(fake.callsOn("b")[0]!.headers["x-key"]).toBeUndefined();
  expect(fake.callsOn("b")[0]!.headers["x-other"]).toBe("synthetic-b");
});

test("every provider failing a path lookup stays an absence of an answer", async () => {
  const fake = fakeProviders({ a: down, b: down });
  PATH_ROUTING_API_URLS.testnet = "https://a";
  HORIZON_FALLBACKS.testnet = [{ url: "https://b", headers: {} }];
  const result = await fetchConversionPath(`USDC:${ISSUER}`, "1", "testnet", "native", {
    fetch: fake.fetch,
    client: { policy: { maxRetries: 0 } },
  });
  expect(result.kind).toBe("unavailable");
});
