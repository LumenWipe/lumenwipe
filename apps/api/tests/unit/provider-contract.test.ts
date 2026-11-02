import { expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import {
  checkProviderContract,
  checkProviders,
  shapeDiff,
  type ContractGet,
  type ContractResponse,
} from "@/lib/monitors/provider-contract";
import { UpstreamError } from "@/lib/stellar/upstream-client";

const SELLER = Keypair.random().publicKey();
const CLAIMANT = Keypair.random().publicKey();
const SPONSOR = Keypair.random().publicKey();
const LINKS = { next: { href: "https://provider.example/next" } };

const OFFER = {
  id: "1",
  seller: SELLER,
  selling: { asset_type: "native" },
  buying: { asset_type: "native" },
  amount: "1.0000000",
  price: "1.0000000",
};
const BALANCE = {
  id: "00",
  asset: "native",
  amount: "1.0000000",
  sponsor: SPONSOR,
  claimants: [{ destination: CLAIMANT, predicate: { unconditional: true } }],
};
const ACCOUNT = {
  sequence: "42",
  subentry_count: 0,
  thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
  flags: { auth_immutable: false },
  signers: [],
  balances: [],
  data: {},
  num_sponsoring: 0,
  num_sponsored: 0,
};
const ASSET = {
  num_claimable_balances: 0,
  num_liquidity_pools: 0,
  num_contracts: 0,
  accounts: {},
  balances: {},
  claimable_balances_amount: "0",
  liquidity_pools_amount: "0",
  contracts_amount: "0",
};

const page = (...records: unknown[]): unknown => ({
  _embedded: { records },
  _links: LINKS,
});

type Answer = ContractResponse | null;

function healthy(path: string): Answer {
  const withHeader = (body: unknown): Answer => ({ body, hasLatestLedger: true });
  if (path === `/accounts/${SELLER}`) return withHeader(ACCOUNT);
  if (path.startsWith(`/accounts/${SELLER}/offers`)) return withHeader(page(OFFER));
  if (path.startsWith(`/accounts/${SELLER}/operations`)) {
    return { body: page({ type: "payment", source_account: SELLER }), hasLatestLedger: false };
  }
  if (path.startsWith("/accounts/")) return null;
  if (path.startsWith("/offers")) return withHeader(page(OFFER));
  if (path.startsWith("/claimable_balances")) return withHeader(page(BALANCE));
  if (path.startsWith("/assets")) return withHeader(page(ASSET));
  return withHeader(page({ destination_amount: "1.0000000", path: [] }));
}

function provider(override: (path: string) => Answer | undefined = () => undefined): {
  get: ContractGet;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    get: async (path) => {
      paths.push(path);
      const answer = override(path);
      return answer === undefined ? healthy(path) : answer;
    },
  };
}

test("a healthy provider has no findings, and operations need no Latest-Ledger", async () => {
  expect(await checkProviderContract("testnet", provider().get)).toEqual([]);
});

test("a missing required field reads as a diff naming route, field and type", async () => {
  const rest: Partial<typeof ACCOUNT> = { ...ACCOUNT };
  delete rest.subentry_count;
  const broken = provider((path) =>
    path === `/accounts/${SELLER}` ? { body: rest, hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("testnet", broken.get)).toEqual([
    "/accounts/{id}: missing subentry_count (expected number)",
  ]);
});

test("a nested field and a changed type are both reported", () => {
  expect(shapeDiff({ a: "1", b: {} }, { a: "number", "b.c": "boolean" })).toEqual([
    "a is string (expected number)",
    "missing b.c (expected boolean)",
  ]);
});

test.each([
  ["/accounts/{id}", (p: string) => p === `/accounts/${SELLER}`],
  ["/accounts/{id}/offers", (p: string) => p.startsWith(`/accounts/${SELLER}/offers`)],
  ["/claimable_balances?claimant", (p: string) => p.includes("claimant=")],
])("%s must carry Latest-Ledger", async (route, matches) => {
  const broken = provider((path) => {
    if (!matches(path)) return undefined;
    const answer = healthy(path);
    return answer && { ...answer, hasLatestLedger: false };
  });
  expect(await checkProviderContract("testnet", broken.get)).toEqual([
    `${route}: missing Latest-Ledger header`,
  ]);
});

test("an empty collection is a finding, never a skip", async () => {
  const broken = provider((path) =>
    path.startsWith("/offers") ? { body: page(), hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("testnet", broken.get)).toEqual([
    "/offers: no record to check against",
  ]);
});

test.each([
  ["/accounts/{id}/offers", `/accounts/${SELLER}/offers`],
  ["/claimable_balances?claimant", "/claimable_balances?claimant="],
  ["/claimable_balances?sponsor", "/claimable_balances?sponsor="],
])("%s may be emptied by live data between requests", async (_, prefix) => {
  const emptied = provider((path) =>
    path.startsWith(prefix) ? { body: page(), hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("mainnet", emptied.get)).toEqual([]);
});

test("an emptied derived route still answers for its paging link and records array", async () => {
  const lostLink = provider((path) =>
    path.startsWith(`/accounts/${SELLER}/offers`)
      ? { body: { _embedded: { records: [] } }, hasLatestLedger: true }
      : undefined
  );
  expect(await checkProviderContract("mainnet", lostLink.get)).toEqual([
    "/accounts/{id}/offers: missing _links.next.href (expected string)",
  ]);

  const lostRecords = provider((path) =>
    path.startsWith("/claimable_balances?sponsor=")
      ? { body: { _links: LINKS }, hasLatestLedger: true }
      : undefined
  );
  expect(await checkProviderContract("mainnet", lostRecords.get)).toEqual([
    "/claimable_balances?sponsor: missing _embedded.records (expected array)",
  ]);
});

test("an emptied derived route still needs Latest-Ledger where a snapshot reads it", async () => {
  const broken = provider((path) =>
    path.startsWith("/claimable_balances?claimant=")
      ? { body: page(), hasLatestLedger: false }
      : undefined
  );
  expect(await checkProviderContract("mainnet", broken.get)).toEqual([
    "/claimable_balances?claimant: missing Latest-Ledger header",
  ]);
});

test("the sponsor route runs on the sponsor, or on the claimant when there is none", async () => {
  const sponsored = provider();
  await checkProviderContract("mainnet", sponsored.get);
  expect(sponsored.paths).toContain(`/claimable_balances?sponsor=${SPONSOR}&limit=1`);

  const unsponsored: Partial<typeof BALANCE> = { ...BALANCE };
  delete unsponsored.sponsor;
  const plain = provider((path) =>
    path.startsWith("/claimable_balances")
      ? { body: page(unsponsored), hasLatestLedger: true }
      : undefined
  );
  expect(await checkProviderContract("mainnet", plain.get)).toEqual([]);
  expect(plain.paths).toContain(`/claimable_balances?sponsor=${CLAIMANT}&limit=1`);
});

test.each([
  ["seller", "../../admin"],
  ["seller", `${SELLER}?x=1`],
  ["claimant", "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"],
  ["sponsor", "not-an-address"],
])("a discovered %s of %s is refused, never requested or echoed", async (field, value) => {
  const record =
    field === "seller"
      ? { ...OFFER, seller: value }
      : field === "claimant"
        ? { ...BALANCE, claimants: [{ destination: value }] }
        : { ...BALANCE, sponsor: value };
  const collection = field === "seller" ? "/offers" : "/claimable_balances";
  const broken = provider((path) =>
    path.startsWith(`${collection}?limit`)
      ? { body: page(record), hasLatestLedger: true }
      : undefined
  );
  const lines = await checkProviderContract("mainnet", broken.get);
  expect(lines.join("\n")).toContain("is not a valid account address");
  expect(lines.join("\n")).not.toContain(value);
  expect(broken.paths.some((path) => path.includes(value))).toBe(false);
});

test("asset stats switched off, an answer of 200 with no records, is a finding", async () => {
  const broken = provider((path) =>
    path.startsWith("/assets") ? { body: page(), hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("mainnet", broken.get)).toEqual([
    "/assets?asset_issuer: no record to check against",
  ]);
});

test("a market with no route is fine, a missing records array is not", async () => {
  const empty = provider((path) =>
    path.startsWith("/paths") ? { body: page(), hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("testnet", empty.get)).toEqual([]);

  const broken = provider((path) =>
    path.startsWith("/paths") ? { body: {}, hasLatestLedger: true } : undefined
  );
  expect(await checkProviderContract("testnet", broken.get)).toEqual([
    "/paths/strict-send: missing _embedded.records (expected array)",
  ]);
});

test("a withdrawn endpoint and an outage are reported apart from drift", async () => {
  const broken: ContractGet = async (path) => {
    if (path.startsWith("/assets")) return null;
    if (path.startsWith("/paths")) throw new UpstreamError("rate_limited", "horizon");
    return healthy(path);
  };
  expect(await checkProviderContract("testnet", broken)).toEqual([
    "/assets?asset_issuer: answered 404",
    "/paths/strict-send: no answer (rate_limited)",
  ]);
});

test("an unknown account must answer 404", async () => {
  const broken = provider((path) =>
    path.startsWith("/accounts/") && !path.includes(SELLER)
      ? { body: ACCOUNT, hasLatestLedger: true }
      : undefined
  );
  expect(await checkProviderContract("testnet", broken.get)).toEqual([
    "/accounts/{unknown}: expected 404",
  ]);
});

test("printed lines hold route templates, never an address", async () => {
  const broken = provider((path) =>
    path === `/accounts/${SELLER}` ? { body: {}, hasLatestLedger: false } : undefined
  );
  const lines = await checkProviderContract("testnet", broken.get);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n")).not.toContain(SELLER);
});

test("one provider and several are each checked and labelled by list position", async () => {
  const one = await checkProviders(
    "testnet",
    [{ url: "https://a.test", headers: {} }],
    () => provider().get
  );
  expect(one).toEqual([{ label: "testnet provider 1 of 1", problems: [] }]);

  const gets = [provider(), provider(() => null)];
  const many = await checkProviders(
    "mainnet",
    [
      { url: "https://a.test", headers: {} },
      { url: "https://b.test", headers: {} },
    ],
    (p) => gets[p.url.includes("a.test") ? 0 : 1]!.get
  );
  expect(many.map((r) => r.label)).toEqual(["mainnet provider 1 of 2", "mainnet provider 2 of 2"]);
  expect(many[0]?.problems).toEqual([]);
  expect(many[1]?.problems.length).toBeGreaterThan(0);
  expect(gets[0]!.paths.length).toBeGreaterThan(0);
  expect(gets[1]!.paths.length).toBeGreaterThan(0);
});

test.each([
  ["the path", "https://provider.example/keys/aaaaaaaa"],
  ["the subdomain", "https://aaaaaaaa.provider.example"],
  ["the query", "https://provider.example?key=aaaaaaaa"],
])("a key in %s never reaches the output, and only GET is sent", async (_, url) => {
  const methods: string[] = [];
  const requested: string[] = [];
  const logged: string[] = [];
  const realFetch = globalThis.fetch;
  const spies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
      logged.push(JSON.stringify(line));
    })
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    requested.push(String(input));
    return new Response(JSON.stringify({ error: `failed at ${url}` }), { status: 400 });
  }) as unknown as typeof globalThis.fetch;
  try {
    const reports = await checkProviders("testnet", [{ url, headers: {} }]);
    const output = JSON.stringify(reports) + logged.join("\n");
    expect(reports[0]?.problems.length).toBeGreaterThan(0);
    expect(output).not.toContain("aaaaaaaa");
    expect(output).not.toContain("provider.example");
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  } finally {
    globalThis.fetch = realFetch;
    spies.forEach((s) => s.mockRestore());
  }
});
