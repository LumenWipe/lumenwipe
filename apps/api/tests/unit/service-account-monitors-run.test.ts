import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../scripts/monitors/service-accounts";

// Runs the service-account checks end to end against a stubbed Horizon, to prove which reads end
// as `clean`, `finding` or `incomplete` in the status the workflow's report reads.

const MEDIATOR = "GC74GMMLV3TEZEDPECBJFJHJAZECEK7AYALUO3WNL4ZDJFLMTVJF6LC5";
const SPONSOR = "GD6VXLZZPNRO4J2PNM4AUPS6OYMLPAE3XPSNCV2NSGEWN5FC2A7DCK5E";
const OPERATOR = "GD7VZL7FUZP4MZY2ROW4L7TQ4D2N47NRWWO2B4TJJWOFUV74AZZGYAHQ";
const USER = "GD27CZC3DRI2YPKIDXIEPMHVBWXSTOFO7HNK5OMIZBMS7N6UWUNM2SOP";

const ENV = {
  MEDIATOR_ADDRESS_TESTNET: MEDIATOR,
  FEE_ACCOUNT_ADDRESS_TESTNET: SPONSOR,
  OPERATOR_ADDRESS_TESTNET: OPERATOR,
};

type Route = (path: string) => Response | Promise<Response>;

const dir = mkdtempSync(join(tmpdir(), "monitors-run-"));
const realFetch = globalThis.fetch;
const realWrite = { out: process.stdout.write, err: process.stderr.write };
const savedEnv: Record<string, string | undefined> = {};
let printed: string[] = [];
let run = 0;

beforeAll(() => {
  for (const key of [...Object.keys(ENV), "GITHUB_OUTPUT", "MONITOR_HISTORY_HOURS"]) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, ENV);
  delete process.env.MONITOR_HISTORY_HOURS;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite.out;
  process.stderr.write = realWrite.err;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const page = (records: unknown[] = []) => json({ _embedded: { records } });
const now = () => new Date().toISOString();

/** Every list empty and no sequence ever moved: the clean shape of the testnet accounts. */
const quiet: Route = (path) =>
  path.includes("?") ? page() : json({ balances: [{ asset_type: "native", balance: "100" }] });

async function check(
  name: string,
  route: Route,
  options?: Parameters<typeof main>[1]
): Promise<{ code: number; status: string | undefined; printed: string }> {
  run++;
  const output = join(dir, `output-${run}`);
  writeFileSync(output, "");
  process.env.GITHUB_OUTPUT = output;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return route(`${url.pathname}${url.search}`);
  }) as typeof fetch;
  printed = [];
  const capture = (chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  const code = await main(name, options);
  process.stdout.write = realWrite.out;
  process.stderr.write = realWrite.err;
  const status = /^status=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1];
  return { code, status, printed: printed.join("") };
}

describe("the keys check", () => {
  test("nothing signed and everything read: clean, exit 0", async () => {
    const result = await check("keys", quiet);
    expect(result.status).toBe("clean");
    expect(result.code).toBe(0);
  });

  test("a transaction the relay sourced: finding", async () => {
    const result = await check("keys", (path) =>
      path.startsWith(`/accounts/${MEDIATOR}/transactions`)
        ? page([
            {
              hash: "ab".repeat(32),
              created_at: now(),
              source_account: MEDIATOR,
              paging_token: "1",
            },
          ])
        : quiet(path)
    );
    expect(result.status).toBe("finding");
    expect(result.code).toBe(1);
  });

  test("a sequence that moved, with no history read at all: still a finding", async () => {
    const moved = String(Math.floor(Date.now() / 1000));
    const result = await check("keys", (path) => {
      if (path === `/accounts/${MEDIATOR}`) return json({ balances: [], sequence_time: moved });
      if (path.includes("?")) return new Response("busy", { status: 503 });
      return quiet(path);
    });
    expect(result.status).toBe("finding");
    expect(result.printed).toContain("incomplete read, not a finding");
  });

  test("Horizon failing for one account: incomplete, and the other account is still read", async () => {
    const reads: string[] = [];
    const result = await check("keys", (path) => {
      reads.push(path);
      return path.startsWith(`/accounts/${MEDIATOR}/operations`)
        ? new Response("busy", { status: 503 })
        : quiet(path);
    });
    expect(result.status).toBe("incomplete");
    expect(result.code).toBe(1);
    expect(reads.some((p) => p.startsWith(`/accounts/${SPONSOR}/operations`))).toBe(true);
  });

  test("a history past the page cap: incomplete", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      hash: i.toString(16).padStart(64, "0"),
      created_at: now(),
      source_account: USER,
      paging_token: String(1000 - i),
    }));
    const result = await check(
      "keys",
      (path) => (path.startsWith(`/accounts/${MEDIATOR}/transactions`) ? page(full) : quiet(path)),
      { maxPages: 1 }
    );
    expect(result.status).toBe("incomplete");
    expect(result.printed).toContain("the 1-page cap was reached");
  });

  test("the time budget running out: incomplete, not a hang", async () => {
    const result = await check(
      "keys",
      (path) => new Promise<Response>((resolve) => setTimeout(() => resolve(quiet(path)), 200)),
      { budgetMs: 50 }
    );
    expect(result.status).toBe("incomplete");
    expect(result.printed).toContain("time budget ran out");
  });
});

describe("the forward check", () => {
  const debit = (amount: string, token: string) => ({
    type: "account_debited",
    account: MEDIATOR,
    amount,
    created_at: now(),
    paging_token: token,
  });

  test("a forward equal to its merge: clean", async () => {
    const result = await check("forward", (path) =>
      path.startsWith(`/accounts/${MEDIATOR}/effects`)
        ? page([
            debit("10", "24829588190277634-2"),
            { ...debit("10", "24829588190277633-2"), type: "account_credited" },
          ])
        : quiet(path)
    );
    expect(result.status).toBe("clean");
  });

  test("a payout, while the sponsor's effects could not be read: finding", async () => {
    const result = await check("forward", (path) => {
      if (path.startsWith(`/accounts/${MEDIATOR}/effects`)) {
        return page([debit("5", "24829588190277634-2")]);
      }
      if (path.startsWith(`/accounts/${SPONSOR}/effects`)) {
        return new Response("busy", { status: 503 });
      }
      return quiet(path);
    });
    expect(result.status).toBe("finding");
    expect(result.printed).toContain("paid out 5 XLM but the merge delivered 0 XLM");
  });

  test("a credit flood past the cap costs one request a page and ends incomplete", async () => {
    const reads: string[] = [];
    const flood = Array.from({ length: 200 }, (_, i) => ({
      ...debit("0.0000001", `${(24829588190277632n - BigInt(i) * 4096n + 1n).toString()}-1`),
      type: "account_credited",
    }));
    const result = await check(
      "forward",
      (path) => {
        reads.push(path);
        return path.startsWith(`/accounts/${MEDIATOR}/effects`) ? page(flood) : quiet(path);
      },
      { maxPages: 2 }
    );
    expect(result.status).toBe("incomplete");
    expect(reads.filter((p) => p.startsWith(`/accounts/${MEDIATOR}/`))).toHaveLength(2);
  });
});

describe("the balances check", () => {
  test("an account Horizon cannot return is incomplete, and the next account is still read", async () => {
    const reads: string[] = [];
    const result = await check("balances", (path) => {
      reads.push(path);
      return path === `/accounts/${MEDIATOR}` ? new Response("busy", { status: 503 }) : quiet(path);
    });
    expect(result.status).toBe("incomplete");
    expect(reads).toContain(`/accounts/${SPONSOR}`);
    expect(result.printed).toContain("could not be read: Horizon testnet returned 503");
  });
});

describe("a check that could not start", () => {
  test("an unknown check is incomplete, never clean", async () => {
    const result = await check("nonsense", quiet);
    expect(result.status).toBe("incomplete");
    expect(result.code).toBe(1);
  });
});
