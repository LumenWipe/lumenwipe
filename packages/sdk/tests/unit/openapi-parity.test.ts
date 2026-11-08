import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LumenWipeClient,
  LumenWipeIntegratorClient,
  type CloseTransactionsRequest,
  type FetchLike,
} from "../../src/index";
import { SDK_VERSION } from "../../src/version";

// Every operation in the committed OpenAPI spec is either called by an SDK method (SDK_OPERATIONS)
// or excluded here with the reason. A new API route fails this test until it gets one or the other.
const SPEC = JSON.parse(
  readFileSync(new URL("../../../../docs/api-reference/openapi.json", import.meta.url), "utf8")
) as { paths: Record<string, Record<string, unknown>> };

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SPEC_OPERATIONS = Object.entries(SPEC.paths).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((method) => HTTP_METHODS.has(method))
    .map((method) => `${method.toUpperCase()} ${path}`)
);

const EXCLUDED: Record<string, string> = {
  "GET /":
    "The service banner (name and docs link). Operational, unversioned, and carries nothing an integrator acts on.",
  "GET /health/dependencies":
    "The operator's view of each upstream's last probe, for the status page. Its rows describe our providers, not the contract; integrators use health() or healthDeep().",
};

type Clients = { client: LumenWipeClient; integrator: LumenWipeIntegratorClient };

// An address with characters a path must not carry raw, so the encoding is part of every check.
const ADDRESS = "G/A?B#C";

const SDK_OPERATIONS: Record<string, [method: string, call: (c: Clients) => Promise<unknown>]> = {
  "GET /health": ["health", ({ client }) => client.health()],
  "GET /health/deep": ["healthDeep", ({ client }) => client.healthDeep()],
  "GET /v1/config/exchange-registry": [
    "getExchangeRegistry",
    ({ client }) => client.getExchangeRegistry(),
  ],
  "POST /v1/{network}/close/plan": ["closePlan", ({ client }) => client.closePlan({ source: "G" })],
  "POST /v1/{network}/close/batch-plan": [
    "batchPlan",
    ({ client }) => client.batchPlan({ addresses: ["G"] }),
  ],
  "POST /v1/{network}/close/transactions": [
    "closeTransactions",
    ({ client }) => client.closeTransactions({ source: "G" } as CloseTransactionsRequest),
  ],
  "POST /v1/{network}/submit": ["submit", ({ client }) => client.submit("xdr")],
  "GET /v1/{network}/transactions/{hash}": [
    "getTransaction",
    ({ client }) => client.getTransaction(ADDRESS),
  ],
  "GET /v1/{network}/close/status": ["closeStatus", ({ client }) => client.closeStatus("G")],
  "GET /v1/{network}/close/delivered": [
    "closeDelivered",
    ({ client }) => client.closeDelivered("G", ["a"]),
  ],
  "GET /v1/{network}/stats": ["getStats", ({ client }) => client.getStats()],
  "GET /v1/{network}/stats/feed": ["getStatsFeed", ({ client }) => client.getStatsFeed()],
  "POST /v1/{network}/stats/merges": ["recordMerge", ({ client }) => client.recordMerge("a")],
  "GET /v1/{network}/account/{address}": ["getAccount", ({ client }) => client.getAccount(ADDRESS)],
  "GET /v1/{network}/allowances/{address}": [
    "getAllowances",
    ({ client }) => client.getAllowances(ADDRESS),
  ],
  "POST /v1/{network}/allowances/revoke": [
    "revokeAllowance",
    ({ client }) => client.revokeAllowance({ owner: "G", token: "C", spender: "G" }),
  ],
  "GET /v1/{network}/paths": [
    "getPaths",
    ({ client }) => client.getPaths({ fromAsset: "XLM", amount: "1" }),
  ],
  "POST /v1/{network}/mediator/sign": ["mediatorSign", ({ client }) => client.mediatorSign("xdr")],
  "GET /v1/{network}/mediator/check/{address}": [
    "mediatorCheck",
    ({ client }) => client.mediatorCheck(ADDRESS),
  ],
  "POST /v1/{network}/fee-bump/sponsor": [
    "feeBumpSponsor",
    ({ client }) => client.feeBumpSponsor("xdr"),
  ],
  "POST /v1/integrator/auth/challenge": [
    "challenge",
    ({ integrator }) => integrator.challenge("G"),
  ],
  "POST /v1/integrator/auth/session": [
    "session",
    ({ integrator }) => integrator.session({ address: "G", message: "m", signature: "s" }),
  ],
  "GET /v1/integrator/keys": ["listKeys", ({ integrator }) => integrator.listKeys("t")],
  "POST /v1/integrator/keys": ["createKey", ({ integrator }) => integrator.createKey("t")],
  "POST /v1/integrator/keys/{id}/revoke": [
    "revokeKey",
    ({ integrator }) => integrator.revokeKey("t", ADDRESS),
  ],
  "POST /v1/integrator/keys/{id}/rotate": [
    "rotateKey",
    ({ integrator }) => integrator.rotateKey("t", ADDRESS),
  ],
};

// Unversioned by policy (RELEASING.md): operational routes only.
const UNVERSIONED = new Set(["GET /health", "GET /health/deep"]);

interface Call {
  url: string;
  init: RequestInit;
}

function clients(): { calls: Call[] } & Clients {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return {
    calls,
    client: new LumenWipeClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      network: "testnet",
      fetch,
    }),
    integrator: new LumenWipeIntegratorClient({ baseUrl: "https://api.test", fetch }),
  };
}

function templateRegex(path: string): RegExp {
  const escaped = path
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}$`);
}

function ownMethods(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== "constructor" && typeof Reflect.get(prototype, name) === "function"
  );
}

// Private helpers live on the prototype too; they are named here so a new public method cannot
// hide among them.
const PRIVATE_HELPERS = new Set(["resolveNetwork", "v1"]);

describe("OpenAPI parity", () => {
  test("the spec has operations to compare against", () => {
    expect(SPEC_OPERATIONS.length).toBeGreaterThan(20);
  });

  test("every spec operation has an SDK method or a justified exclusion, never both", () => {
    const missing = SPEC_OPERATIONS.filter((op) => !(op in SDK_OPERATIONS) && !(op in EXCLUDED));
    const both = SPEC_OPERATIONS.filter((op) => op in SDK_OPERATIONS && op in EXCLUDED);
    expect(missing).toEqual([]);
    expect(both).toEqual([]);
    for (const reason of Object.values(EXCLUDED)) expect(reason.length).toBeGreaterThan(40);
  });

  test("no table entry names an operation the spec does not have", () => {
    const spec = new Set(SPEC_OPERATIONS);
    expect(
      [...Object.keys(SDK_OPERATIONS), ...Object.keys(EXCLUDED)].filter((op) => !spec.has(op))
    ).toEqual([]);
  });

  test("every public method of both clients maps to a spec operation", () => {
    const mapped = new Set(Object.values(SDK_OPERATIONS).map(([method]) => method));
    const methods = [
      ...ownMethods(LumenWipeClient.prototype),
      ...ownMethods(LumenWipeIntegratorClient.prototype),
    ].filter((name) => !PRIVATE_HELPERS.has(name));
    expect(methods.filter((name) => !mapped.has(name))).toEqual([]);
    expect([...mapped].filter((name) => !methods.includes(name))).toEqual([]);
  });

  test.each(Object.entries(SDK_OPERATIONS))(
    "%s is what the SDK sends",
    async (operation, [, call]) => {
      const [method, path] = operation.split(" ") as [string, string];
      const c = clients();
      await call(c);
      expect(c.calls).toHaveLength(1);
      const url = new URL(c.calls[0].url);
      expect(c.calls[0].init.method).toBe(method);
      expect(url.origin).toBe("https://api.test");
      expect(url.pathname).toMatch(templateRegex(path.replace("{network}", "testnet")));
      if (!UNVERSIONED.has(operation)) expect(url.pathname.startsWith("/v1/")).toBe(true);
      expect(url.pathname).not.toContain(ADDRESS);
    }
  );
});

// Byte-level pins for the calls that reach signing or submission: only the path moved to /v1, so
// the method, the full headers and the exact body must stay what they were.
describe("wire format of the signing and submission calls", () => {
  const MAIN_HEADERS = {
    Authorization: "Bearer k",
    "X-LumenWipe-SDK": `sdk/${SDK_VERSION}`,
    "Content-Type": "application/json",
  };

  const WIRE: [string, (client: LumenWipeClient) => Promise<unknown>, string, string][] = [
    [
      "mediatorSign",
      (c) => c.mediatorSign("AAAAmediator"),
      "https://api.test/v1/mainnet/mediator/sign",
      '{"transaction":"AAAAmediator"}',
    ],
    [
      "feeBumpSponsor",
      (c) => c.feeBumpSponsor("AAAAinner"),
      "https://api.test/v1/mainnet/fee-bump/sponsor",
      '{"transaction":"AAAAinner"}',
    ],
    [
      "revokeAllowance",
      (c) => c.revokeAllowance({ owner: "GOWNER", token: "CTOKEN", spender: "CSPENDER" }),
      "https://api.test/v1/mainnet/allowances/revoke",
      '{"owner":"GOWNER","token":"CTOKEN","spender":"CSPENDER"}',
    ],
    [
      "submit",
      (c) => c.submit("AAAAsigned"),
      "https://api.test/v1/mainnet/submit",
      '{"signedXdr":"AAAAsigned"}',
    ],
  ];

  test.each(WIRE)("%s sends exactly its URL, headers and body", async (_, call, url, body) => {
    const calls: Call[] = [];
    const client = new LumenWipeClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      network: "mainnet",
      fetch: (u, init) => {
        calls.push({ url: u, init: init ?? {} });
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    await call(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual(MAIN_HEADERS);
    expect(calls[0].init.body).toBe(body);
  });

  test("the main client sends Bearer <apiKey> on every operation", async () => {
    const main = Object.entries(SDK_OPERATIONS).filter(([op]) => !op.includes("/integrator/"));
    expect(main.length).toBeGreaterThan(15);
    for (const [, [, call]] of main) {
      const c = clients();
      await call(c);
      expect((c.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    }
  });

  test("the integrator client never sends an API key, even one passed to it", async () => {
    const ops = Object.entries(SDK_OPERATIONS).filter(([op]) => op.includes("/integrator/"));
    expect(ops).toHaveLength(6);
    for (const [operation, [, call]] of ops) {
      const c = clients();
      const integrator = new LumenWipeIntegratorClient({
        baseUrl: "https://api.test",
        apiKey: "k",
        fetch: (url, init) => {
          c.calls.push({ url, init: init ?? {} });
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      } as ConstructorParameters<typeof LumenWipeIntegratorClient>[0]);
      await call({ client: c.client, integrator });
      const headers = c.calls[0].init.headers as Record<string, string>;
      if (operation.includes("/auth/")) expect(headers.Authorization).toBeUndefined();
      else expect(headers.Authorization).toBe("Bearer t");
    }
  });
});
