import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_HISTORY_HOURS,
  accountsFor,
  addressVariable,
  balanceFinding,
  formatFinding,
  forwardFinding,
  historyWindowHours,
  incompleteHistoryFinding,
  loadServiceAccounts,
  nativeBalanceStroops,
  plannedAccounts,
  retiredVariable,
  sourcedFinding,
  transactionsInWindow,
  type HorizonTransaction,
  type HorizonTransactionPage,
  type PlannedAccounts,
  type ServiceAccount,
} from "@/lib/monitors/service-accounts";

const MEDIATOR = "GC2VH6XP7HTOZHIX4OC3PU5HUXWY5XANGML4F6GBCNH5MBDFN5MU4WG7";
const SPONSOR = "GCMCGC6EJZKJJUTFY6RK43PGOODW6EL6FSHSLXBV4EYSZ3GHNJO3FXAP";
const USER = "GD27CZC3DRI2YPKIDXIEPMHVBWXSTOFO7HNK5OMIZBMS7N6UWUNM2SOP";
// A valid account id that is neither service account (32 bytes of 0x07).
const OTHER = "GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI";

const mediator: ServiceAccount = {
  role: "mediator",
  network: "testnet",
  address: MEDIATOR,
  floorXlm: "1",
};

const tx = {
  hash: "86008a27".padEnd(64, "0"),
  created_at: "2026-08-17T22:59:09Z",
  source_account: USER,
  paging_token: "1",
};

const ROOT = new URL("../../../../", import.meta.url);
const SCRIPT = new URL("apps/api/scripts/monitors/service-accounts.ts", ROOT).pathname;

const testnetOnly: PlannedAccounts = {
  testnet: { mediator: MEDIATOR, sponsor: SPONSOR },
  mainnet: { mediator: null, sponsor: null },
};
const testnetEnv = {
  MEDIATOR_ADDRESS_TESTNET: MEDIATOR,
  FEE_ACCOUNT_ADDRESS_TESTNET: SPONSOR,
};

describe("plannedAccounts", () => {
  const table = (mediatorTestnet: string) =>
    [
      "| Component | On-chain address | Notes |",
      "| --- | --- | --- |",
      `| Mediator account (testnet)  | ${mediatorTestnet} | Co-signs. |`,
      "| Mediator account (mainnet)  | not yet deployed | Gap. |",
      `| Fee-bump sponsor (testnet)  | \`${SPONSOR}\` | Pays fees. |`,
      "| Fee-bump sponsor (mainnet)  | not yet deployed | Gap. |",
    ].join("\n");

  test("reads each role and network from the inventory table", () => {
    expect(plannedAccounts(table(`\`${MEDIATOR}\``))).toEqual(testnetOnly);
  });

  test("rejects a cell that is neither an account id nor not yet deployed", () => {
    expect(() => plannedAccounts(table("TBD"))).toThrow('"Mediator account (testnet)"');
  });

  test("rejects a table with a row missing", () => {
    expect(() => plannedAccounts("| Mediator account (testnet) | not yet deployed |")).toThrow(
      'no "Fee-bump sponsor (testnet)" row'
    );
  });
});

describe("the monitoring plan and stellar.toml agree", () => {
  test("the plan's inventory loads against the published stellar.toml", () => {
    const plan = plannedAccounts(readFileSync(new URL("docs/monitoring-plan.md", ROOT), "utf8"));
    const toml = Bun.TOML.parse(
      readFileSync(new URL("apps/web/public/.well-known/stellar.toml", ROOT), "utf8")
    );
    const env: Record<string, string> = {};
    for (const network of ["testnet", "mainnet"] as const) {
      for (const role of ["mediator", "sponsor"] as const) {
        const address = plan[network][role];
        if (address !== null) env[addressVariable(role, network)] = address;
      }
    }
    expect(loadServiceAccounts(env, plan, toml).length).toBeGreaterThan(0);
  });
});

describe("loadServiceAccounts", () => {
  test("builds the accounts, with each role's floor, from the variables", () => {
    expect(loadServiceAccounts(testnetEnv, testnetOnly, {})).toEqual([
      { role: "mediator", network: "testnet", address: MEDIATOR, floorXlm: "1" },
      { role: "sponsor", network: "testnet", address: SPONSOR, floorXlm: "50" },
    ]);
  });

  test.each(["MEDIATOR_ADDRESS_TESTNET", "FEE_ACCOUNT_ADDRESS_TESTNET"])(
    "fails, naming it, when the plan expects %s and it is unset",
    (name) => {
      const env: Record<string, string> = { ...testnetEnv, [name]: "" };
      expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(`${name} is not set`);
      delete env[name];
      expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(`${name} is not set`);
    }
  );

  test("fails when no account is configured at all", () => {
    const none: PlannedAccounts = {
      testnet: { mediator: null, sponsor: null },
      mainnet: { mediator: null, sponsor: null },
    };
    expect(() => loadServiceAccounts({}, none, {})).toThrow("No service account is configured");
  });

  test("rejects a value that is not an account id", () => {
    const env = { ...testnetEnv, FEE_ACCOUNT_ADDRESS_TESTNET: "not-an-account" };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(
      "FEE_ACCOUNT_ADDRESS_TESTNET is not a Stellar account id"
    );
  });

  test("fails when a variable was rotated without the plan", () => {
    const env = { ...testnetEnv, MEDIATOR_ADDRESS_TESTNET: OTHER };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow("A rotation updates both");
  });

  test("fails when a variable is set for an account the plan says is not deployed", () => {
    const env = { ...testnetEnv, FEE_ACCOUNT_ADDRESS_MAINNET: OTHER };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow("as not yet deployed");
  });

  test("reports every problem at once", () => {
    const message = (() => {
      try {
        loadServiceAccounts({}, testnetOnly, {});
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message.split("\n")).toHaveLength(2);
  });

  describe("against stellar.toml", () => {
    const withMainnet: PlannedAccounts = {
      testnet: { mediator: null, sponsor: null },
      mainnet: { mediator: MEDIATOR, sponsor: SPONSOR },
    };
    const mainnetEnv = { MEDIATOR_ADDRESS_MAINNET: MEDIATOR, FEE_ACCOUNT_ADDRESS_MAINNET: SPONSOR };

    test("accepts the mainnet mediator listed in ACCOUNTS", () => {
      expect(loadServiceAccounts(mainnetEnv, withMainnet, { ACCOUNTS: [MEDIATOR] })).toHaveLength(
        2
      );
    });

    test("fails when the mainnet mediator is configured but not published", () => {
      expect(() => loadServiceAccounts(mainnetEnv, withMainnet, {})).toThrow(
        "does not list the mainnet mediator"
      );
    });

    test("fails when ACCOUNTS lists an account no variable configures", () => {
      expect(() => loadServiceAccounts(testnetEnv, testnetOnly, { ACCOUNTS: [OTHER] })).toThrow(
        `stellar.toml lists ${OTHER}`
      );
    });

    test("fails when ACCOUNTS is not a SEP-1 list of account ids", () => {
      expect(() =>
        loadServiceAccounts(testnetEnv, testnetOnly, { ACCOUNTS: [{ address: MEDIATOR }] })
      ).toThrow("SEP-1");
    });
  });

  test("the runner exits non-zero with the variable's name when one is unset", async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/_ADDRESS_(TESTNET|MAINNET)$/.test(key)) env[key] = value;
    }
    const proc = Bun.spawn([process.execPath, "run", SCRIPT, "config"], {
      cwd: new URL("apps/api", ROOT).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("::error::MEDIATOR_ADDRESS_TESTNET is not set");
    expect(stderr).toContain("::error::FEE_ACCOUNT_ADDRESS_TESTNET is not set");
  });
});

describe("a retired address", () => {
  const retiredEnv = { ...testnetEnv, MEDIATOR_ADDRESS_TESTNET_RETIRED: OTHER };
  const retired: ServiceAccount = {
    role: "mediator",
    network: "testnet",
    address: OTHER,
    floorXlm: "1",
    retired: true,
  };

  test("is the address variable with a _RETIRED suffix", () => {
    expect(retiredVariable("sponsor", "mainnet")).toBe("FEE_ACCOUNT_ADDRESS_MAINNET_RETIRED");
  });

  test("is watched alongside the current account, outside the plan", () => {
    expect(loadServiceAccounts(retiredEnv, testnetOnly, {})).toEqual([
      { role: "mediator", network: "testnet", address: MEDIATOR, floorXlm: "1" },
      { role: "sponsor", network: "testnet", address: SPONSOR, floorXlm: "50" },
      retired,
    ]);
  });

  test("fails when it is not an account id", () => {
    const env = { ...testnetEnv, FEE_ACCOUNT_ADDRESS_TESTNET_RETIRED: "not-an-account" };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(
      "FEE_ACCOUNT_ADDRESS_TESTNET_RETIRED is not a Stellar account id"
    );
  });

  test("fails when it equals the current address", () => {
    const env = { ...testnetEnv, MEDIATOR_ADDRESS_TESTNET_RETIRED: MEDIATOR };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(
      "MEDIATOR_ADDRESS_TESTNET_RETIRED is the current mediator (testnet) account"
    );
  });

  test("does not have to be in stellar.toml, and may not stay listed there", () => {
    const withMainnet: PlannedAccounts = {
      testnet: { mediator: null, sponsor: null },
      mainnet: { mediator: MEDIATOR, sponsor: null },
    };
    const env = { MEDIATOR_ADDRESS_MAINNET: MEDIATOR, MEDIATOR_ADDRESS_MAINNET_RETIRED: OTHER };
    expect(loadServiceAccounts(env, withMainnet, { ACCOUNTS: [MEDIATOR] })).toHaveLength(2);
    expect(() => loadServiceAccounts(env, withMainnet, { ACCOUNTS: [MEDIATOR, OTHER] })).toThrow(
      `stellar.toml lists ${OTHER}`
    );
  });

  test("is read by the keys and forward checks but has no balance floor", () => {
    const accounts = loadServiceAccounts(retiredEnv, testnetOnly, {});
    expect(accountsFor(accounts, "keys")).toContainEqual(retired);
    expect(accountsFor(accounts, "forward")).toEqual([mediator, retired]);
    expect(accountsFor(accounts, "balances")).not.toContainEqual(retired);
    expect(accountsFor(accounts, "balances")).toHaveLength(2);
  });

  test("a finding names the account as retired", () => {
    expect(formatFinding({ account: retired, message: "m" })).toBe(
      `mediator (retired) (testnet, ${OTHER}): m`
    );
  });
});

describe("historyWindowHours", () => {
  test("defaults when unset", () => {
    expect(historyWindowHours(undefined)).toBe(DEFAULT_HISTORY_HOURS);
    expect(historyWindowHours("")).toBe(DEFAULT_HISTORY_HOURS);
  });

  test("accepts whole hours in range", () => {
    expect(historyWindowHours("2")).toBe(2);
    expect(historyWindowHours("720")).toBe(720);
  });

  test.each(["1", "721", "abc", "1.5", "-3", " 5", "0x10"])("rejects %p", (raw) => {
    expect(() => historyWindowHours(raw)).toThrow("MONITOR_HISTORY_HOURS");
  });
});

describe("transactionsInWindow", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  // One transaction a minute, newest first, with Horizon's paging token as the position.
  const history: HorizonTransaction[] = Array.from({ length: 450 }, (_, i) => ({
    hash: i.toString(16).padStart(64, "0"),
    created_at: new Date(NOW - i * 60_000).toISOString(),
    source_account: USER,
    paging_token: String(1_000_000 - i),
  }));

  function horizon(records: HorizonTransaction[]) {
    const paths: string[] = [];
    const get = async (path: string): Promise<HorizonTransactionPage> => {
      paths.push(path);
      const query = new URLSearchParams(path.split("?")[1]);
      const cursor = query.get("cursor");
      const start = cursor === null ? 0 : records.findIndex((r) => r.paging_token === cursor) + 1;
      const limit = Number(query.get("limit"));
      return { _embedded: { records: records.slice(start, start + limit) } };
    };
    return { get, paths };
  }

  test("pages with the last paging token until the window start", async () => {
    const { get, paths } = horizon(history);
    const since = new Date(NOW - 420 * 60_000);
    const result = await transactionsInWindow(get, MEDIATOR, since);
    expect(result.complete).toBe(true);
    expect(result.transactions.map((t) => t.hash)).toEqual(
      history.slice(0, 421).map((t) => t.hash)
    );
    expect(paths).toEqual([
      `/accounts/${MEDIATOR}/transactions?limit=200&order=desc`,
      `/accounts/${MEDIATOR}/transactions?limit=200&order=desc&cursor=${history[199].paging_token}`,
      `/accounts/${MEDIATOR}/transactions?limit=200&order=desc&cursor=${history[399].paging_token}`,
    ]);
  });

  test("keeps a transaction exactly at the window start and drops one a millisecond older", async () => {
    const records = [
      { ...history[0], created_at: "2026-11-08T11:00:00.000Z" },
      { ...history[1], created_at: "2026-11-08T10:59:59.999Z" },
    ];
    const { get } = horizon(records);
    const result = await transactionsInWindow(get, MEDIATOR, new Date("2026-11-08T11:00:00Z"));
    expect(result.transactions).toEqual([records[0]]);
  });

  test("a short last page ends the history without another request", async () => {
    const { get, paths } = horizon(history);
    const result = await transactionsInWindow(get, MEDIATOR, new Date(0));
    expect(result).toEqual({ transactions: history, complete: true });
    expect(paths).toHaveLength(3);
  });

  test("an account with no history is one request", async () => {
    const { get, paths } = horizon([]);
    expect(await transactionsInWindow(get, MEDIATOR, new Date(0))).toEqual({
      transactions: [],
      complete: true,
    });
    expect(paths).toHaveLength(1);
  });

  test("stops at the page cap and says the window was not fully read", async () => {
    const { get, paths } = horizon(history);
    const result = await transactionsInWindow(get, MEDIATOR, new Date(0), 2);
    expect(result.complete).toBe(false);
    expect(result.transactions).toHaveLength(400);
    expect(paths).toHaveLength(2);
    expect(incompleteHistoryFinding(mediator, 168).message).toContain("in the last 168 h");
  });
});

describe("sourcedFinding", () => {
  test("a transaction the account sourced fires", () => {
    const finding = sourcedFinding(mediator, { ...tx, source_account: MEDIATOR });
    expect(finding?.message).toContain(tx.hash);
  });

  test("a transaction someone else sourced is quiet", () => {
    expect(sourcedFinding(mediator, tx)).toBeNull();
  });
});

describe("balanceFinding", () => {
  const horizon = (balance: string) => ({
    balances: [
      { asset_type: "credit_alphanum4", balance: "999.0000000" },
      { asset_type: "native", balance },
    ],
  });

  test("reads the native balance, not the first balance", () => {
    expect(nativeBalanceStroops(horizon("10000.0000000"))).toBe(100_000_000_000n);
  });

  test("is quiet at or above the floor", () => {
    expect(balanceFinding(mediator, horizon("1.0000000"))).toBeNull();
    expect(balanceFinding(mediator, horizon("10000.0000000"))).toBeNull();
  });

  test("fires one stroop below the floor", () => {
    const finding = balanceFinding(mediator, horizon("0.9999999"));
    expect(finding?.message).toBe("native balance 0.9999999 XLM is below the 1 XLM floor");
  });

  test("fires when Horizon lists no native balance at all", () => {
    expect(balanceFinding(mediator, { balances: [] })?.message).toContain("no native balance");
  });
});

describe("forwardFinding", () => {
  const merge = (amount: string) => ({ type: "account_credited", account: MEDIATOR, amount });
  const forward = (amount: string) => ({ type: "account_debited", account: MEDIATOR, amount });

  test("a forward equal to the merge is the legitimate shape", () => {
    const effects = [
      { type: "account_removed", account: USER },
      merge("9999.9999800"),
      forward("9999.9999800"),
      { type: "account_credited", account: "GEXCHANGE", amount: "9999.9999800" },
    ];
    expect(forwardFinding(mediator, tx, effects)).toBeNull();
  });

  test("a forward one stroop above the merge fires", () => {
    const finding = forwardFinding(mediator, tx, [merge("100.0000000"), forward("100.0000001")]);
    expect(finding?.message).toContain("paid out 100.0000001 XLM but the merge delivered 100 XLM");
    expect(finding?.message).toContain(tx.hash);
  });

  test("a forward with no merge at all fires", () => {
    expect(forwardFinding(mediator, tx, [forward("5")])).not.toBeNull();
  });

  test("an operator top-up is only a credit and stays quiet", () => {
    expect(forwardFinding(mediator, tx, [merge("50")])).toBeNull();
  });

  test("effects on other accounts do not count", () => {
    const effects = [
      merge("10"),
      forward("10"),
      { type: "account_debited", account: USER, amount: "1000" },
    ];
    expect(forwardFinding(mediator, tx, effects)).toBeNull();
  });
});
