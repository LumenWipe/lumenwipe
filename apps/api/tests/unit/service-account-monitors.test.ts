import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_HISTORY_HOURS,
  accountsFor,
  addressVariable,
  anyDebitIsPayout,
  balanceFinding,
  checkStatus,
  formatFinding,
  forwardFindings,
  historyWindowHours,
  incompleteRead,
  keysFindings,
  loadServiceAccounts,
  nativeBalanceStroops,
  operationsInWindow,
  plannedAccounts,
  operatorVariable,
  removalOperations,
  retiredVariable,
  sequenceFinding,
  sourcedFinding,
  sponsorDebitFindings,
  effectsInWindow,
  transactionOf,
  transactionsInWindow,
  wholeTransactions,
  type HorizonAccountEffect,
  type HorizonEffect,
  type HorizonOperation,
  type HorizonTransaction,
  type HorizonTransactionPage,
  type PlannedAccounts,
  type ServiceAccount,
} from "@/lib/monitors/service-accounts";

const MEDIATOR = "GC74GMMLV3TEZEDPECBJFJHJAZECEK7AYALUO3WNL4ZDJFLMTVJF6LC5";
const SPONSOR = "GD6VXLZZPNRO4J2PNM4AUPS6OYMLPAE3XPSNCV2NSGEWN5FC2A7DCK5E";
const USER = "GD27CZC3DRI2YPKIDXIEPMHVBWXSTOFO7HNK5OMIZBMS7N6UWUNM2SOP";
// A valid account id that is neither service account (32 bytes of 0x07).
const OTHER = "GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI";
// The testnet rotation of 2026-11-17: the operator and the two accounts it drained.
const OPERATOR = "GD7VZL7FUZP4MZY2ROW4L7TQ4D2N47NRWWO2B4TJJWOFUV74AZZGYAHQ";
const RETIRED_RELAY = "GC2VH6XP7HTOZHIX4OC3PU5HUXWY5XANGML4F6GBCNH5MBDFN5MU4WG7";
const RETIRED_SPONSOR = "GCMCGC6EJZKJJUTFY6RK43PGOODW6EL6FSHSLXBV4EYSZ3GHNJO3FXAP";

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
  testnet: { mediator: MEDIATOR, sponsor: SPONSOR, operator: OPERATOR },
  mainnet: { mediator: null, sponsor: null, operator: null },
};
const testnetEnv = {
  MEDIATOR_ADDRESS_TESTNET: MEDIATOR,
  FEE_ACCOUNT_ADDRESS_TESTNET: SPONSOR,
  OPERATOR_ADDRESS_TESTNET: OPERATOR,
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
      `| Rotation operator (testnet) | \`${OPERATOR}\` | Drains. |`,
      "| Rotation operator (mainnet) | not yet deployed | Gap. |",
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
      const operator = plan[network].operator;
      if (operator !== null) env[operatorVariable(network)] = operator;
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
      testnet: { mediator: null, sponsor: null, operator: null },
      mainnet: { mediator: null, sponsor: null, operator: null },
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
    expect(message.split("\n")).toHaveLength(3);
  });

  describe("against stellar.toml", () => {
    const withMainnet: PlannedAccounts = {
      testnet: { mediator: null, sponsor: null, operator: null },
      mainnet: { mediator: MEDIATOR, sponsor: SPONSOR, operator: null },
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
    expect(stderr).toContain("::error::OPERATOR_ADDRESS_TESTNET is not set");
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
    drainTo: OPERATOR,
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
      testnet: { mediator: null, sponsor: null, operator: null },
      mainnet: { mediator: MEDIATOR, sponsor: null, operator: OPERATOR },
    };
    const env = {
      MEDIATOR_ADDRESS_MAINNET: MEDIATOR,
      MEDIATOR_ADDRESS_MAINNET_RETIRED: OTHER,
      OPERATOR_ADDRESS_MAINNET: OPERATOR,
    };
    expect(loadServiceAccounts(env, withMainnet, { ACCOUNTS: [MEDIATOR] })).toHaveLength(2);
    expect(() => loadServiceAccounts(env, withMainnet, { ACCOUNTS: [MEDIATOR, OTHER] })).toThrow(
      `stellar.toml lists ${OTHER}`
    );
  });

  test("is read by the keys and forward checks but has no balance floor", () => {
    const accounts = loadServiceAccounts(retiredEnv, testnetOnly, {});
    expect(accountsFor(accounts, "keys")).toContainEqual(retired);
    expect(accountsFor(accounts, "forward")).toContainEqual(retired);
    expect(accountsFor(accounts, "balances")).not.toContainEqual(retired);
    expect(accountsFor(accounts, "balances")).toHaveLength(2);
  });

  test("a finding names the account as retired", () => {
    expect(formatFinding({ account: retired, message: "m" })).toBe(
      `mediator (retired) (testnet, ${OTHER}): m`
    );
  });
});

describe("the rotation operator", () => {
  test("is a variable per network", () => {
    expect(operatorVariable("mainnet")).toBe("OPERATOR_ADDRESS_MAINNET");
  });

  test("is held to the plan like the service accounts", () => {
    const rotated = { ...testnetEnv, OPERATOR_ADDRESS_TESTNET: OTHER };
    expect(() => loadServiceAccounts(rotated, testnetOnly, {})).toThrow(
      `OPERATOR_ADDRESS_TESTNET is ${OTHER}, but docs/monitoring-plan.md lists the rotation operator (testnet) account as ${OPERATOR}`
    );
    const unset = { ...testnetEnv, OPERATOR_ADDRESS_TESTNET: "" };
    expect(() => loadServiceAccounts(unset, testnetOnly, {})).toThrow(
      "OPERATOR_ADDRESS_TESTNET is not set"
    );
    const undeployed = { ...testnetEnv, OPERATOR_ADDRESS_MAINNET: OTHER };
    expect(() => loadServiceAccounts(undeployed, testnetOnly, {})).toThrow("as not yet deployed");
  });

  test.each([
    "not-an-account",
    "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ` ${OPERATOR}`,
  ])("rejects %p, which is not an account id", (value) => {
    const env = { ...testnetEnv, OPERATOR_ADDRESS_TESTNET: value };
    expect(() => loadServiceAccounts(env, testnetOnly, {})).toThrow(
      "OPERATOR_ADDRESS_TESTNET is not a Stellar account id"
    );
  });

  test("is not a service account", () => {
    const plan: PlannedAccounts = {
      ...testnetOnly,
      testnet: { ...testnetOnly.testnet, operator: SPONSOR },
    };
    const env = { ...testnetEnv, OPERATOR_ADDRESS_TESTNET: SPONSOR };
    expect(() => loadServiceAccounts(env, plan, {})).toThrow(
      "OPERATOR_ADDRESS_TESTNET is the sponsor (testnet) account"
    );
    const retired = { ...testnetEnv, MEDIATOR_ADDRESS_TESTNET_RETIRED: OPERATOR };
    expect(() => loadServiceAccounts(retired, testnetOnly, {})).toThrow(
      "OPERATOR_ADDRESS_TESTNET is the mediator (retired) (testnet) account"
    );
  });

  test("is required by a retired sponsor too", () => {
    const noOperator: PlannedAccounts = {
      ...testnetOnly,
      testnet: { ...testnetOnly.testnet, operator: null },
    };
    const env = {
      MEDIATOR_ADDRESS_TESTNET: MEDIATOR,
      FEE_ACCOUNT_ADDRESS_TESTNET: SPONSOR,
      FEE_ACCOUNT_ADDRESS_TESTNET_RETIRED: RETIRED_SPONSOR,
    };
    expect(() => loadServiceAccounts(env, noOperator, {})).toThrow(
      "FEE_ACCOUNT_ADDRESS_TESTNET_RETIRED is set, but OPERATOR_ADDRESS_TESTNET is not"
    );
  });

  test("is required by a retired mediator, which carries it as its drain destination", () => {
    const noOperator: PlannedAccounts = {
      ...testnetOnly,
      testnet: { ...testnetOnly.testnet, operator: null },
    };
    const env = {
      MEDIATOR_ADDRESS_TESTNET: MEDIATOR,
      FEE_ACCOUNT_ADDRESS_TESTNET: SPONSOR,
      MEDIATOR_ADDRESS_TESTNET_RETIRED: RETIRED_RELAY,
    };
    expect(() => loadServiceAccounts(env, noOperator, {})).toThrow(
      "MEDIATOR_ADDRESS_TESTNET_RETIRED is set, but OPERATOR_ADDRESS_TESTNET is not"
    );
    const retired = loadServiceAccounts(
      { ...env, OPERATOR_ADDRESS_TESTNET: OPERATOR },
      testnetOnly,
      {}
    ).find((a) => a.retired);
    expect(retired?.drainTo).toBe(OPERATOR);
  });

  test("leaves the current accounts without a drain destination", () => {
    for (const account of loadServiceAccounts(testnetEnv, testnetOnly, {})) {
      expect(account.drainTo).toBeUndefined();
    }
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
    expect(result.stopped).toBe("the 2-page cap was reached; lower MONITOR_HISTORY_HOURS");
    expect(result.transactions).toHaveLength(400);
    expect(paths).toHaveLength(2);
    const unread = incompleteRead(mediator, 168, "transactions", {
      count: result.transactions.length,
      stopped: result.stopped,
    });
    expect(unread.message).toContain(
      "only the newest 400 transactions of the last 168 h were read"
    );
    expect(unread.message).toContain("lower MONITOR_HISTORY_HOURS");
  });

  test("a request that fails keeps the pages read before it and says why it stopped", async () => {
    const { get } = horizon(history);
    let calls = 0;
    const failing = async (path: string) => {
      if (++calls === 2) throw new Error("Horizon testnet returned 503 for /accounts");
      return get(path);
    };
    const result = await transactionsInWindow(failing, MEDIATOR, new Date(0));
    expect(result).toEqual({
      transactions: history.slice(0, 200),
      complete: false,
      stopped: "Horizon testnet returned 503 for /accounts",
    });
  });

  test("a first request that fails is an incomplete read of nothing, never an empty window", async () => {
    const result = await transactionsInWindow(
      async () => {
        throw new Error("the check's 300 s time budget ran out");
      },
      MEDIATOR,
      new Date(0)
    );
    expect(result).toEqual({
      transactions: [],
      complete: false,
      stopped: "the check's 300 s time budget ran out",
    });
    expect(
      incompleteRead(mediator, 168, "transactions", { count: 0, stopped: result.stopped }).message
    ).toBe(
      "none of the transactions of the last 168 h were read before the read stopped: " +
        "the check's 300 s time budget ran out. The rest were not checked."
    );
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

// The account's own effects list, as the forward check reads it: every effect of one transaction
// carries its time and an `<operation id>-<index>` paging token inside that transaction.
const FORWARD_TX = 24829588190277632n;
const inTransaction = (
  effects: HorizonEffect[],
  base = FORWARD_TX,
  createdAt = tx.created_at
): HorizonAccountEffect[] =>
  effects.map((effect, i) => ({
    created_at: createdAt,
    paging_token: `${base + 1n}-${i + 1}`,
    ...effect,
  }));

describe("forwardFindings", () => {
  const merge = (amount: string) => ({ type: "account_credited", account: MEDIATOR, amount });
  const forward = (amount: string) => ({ type: "account_debited", account: MEDIATOR, amount });

  test("a forward equal to the merge is the legitimate shape", () => {
    const effects = inTransaction([
      { type: "account_removed", account: USER },
      merge("9999.9999800"),
      forward("9999.9999800"),
      { type: "account_credited", account: "GEXCHANGE", amount: "9999.9999800" },
    ]);
    expect(forwardFindings(mediator, effects, [])).toEqual([]);
  });

  test("a forward one stroop above the merge fires", () => {
    const effects = inTransaction([merge("100.0000000"), forward("100.0000001")]);
    const [finding] = forwardFindings(mediator, effects, []);
    expect(finding?.message).toContain("paid out 100.0000001 XLM but the merge delivered 100 XLM");
    expect(finding?.message).toContain(`operations ${FORWARD_TX + 1n} (${tx.created_at})`);
  });

  test("a forward with no merge at all fires", () => {
    expect(forwardFindings(mediator, inTransaction([forward("5")]), [])).toHaveLength(1);
  });

  test("an operator top-up is only a credit and stays quiet", () => {
    expect(forwardFindings(mediator, inTransaction([merge("50")]), [])).toEqual([]);
  });

  test("effects on other accounts do not count", () => {
    const effects = inTransaction([
      merge("10"),
      forward("10"),
      { type: "account_debited", account: USER, amount: "1000" },
    ]);
    expect(forwardFindings(mediator, effects, [])).toEqual([]);
  });

  test("a merge in one transaction does not cover a forward in another", () => {
    const effects = [
      ...inTransaction([forward("10")], FORWARD_TX),
      ...inTransaction([merge("10")], FORWARD_TX - 4096n),
    ];
    expect(forwardFindings(mediator, effects, [])).toHaveLength(1);
  });

  test("a credit-only flood is quiet however long", () => {
    const flood = Array.from({ length: 300 }, (_, i) =>
      inTransaction([merge("0.0000001")], FORWARD_TX - BigInt(i) * 4096n)
    ).flat();
    expect(forwardFindings(mediator, flood, [])).toEqual([]);
  });
});

describe("transactionOf", () => {
  test("groups the operations of one transaction by their TOID", () => {
    const [merge, payment] = inTransaction([
      { type: "account_credited", account: MEDIATOR, amount: "1" },
      { type: "account_debited", account: MEDIATOR, amount: "1" },
    ]).map((effect, i) => ({ ...effect, paging_token: `${FORWARD_TX + BigInt(i + 1)}-2` }));
    expect(transactionOf(merge)).toBe(String(FORWARD_TX));
    expect(transactionOf(payment)).toBe(String(FORWARD_TX));
    expect(transactionOf({ ...merge, paging_token: `${FORWARD_TX + 4097n}-1` })).toBe(
      String(FORWARD_TX + 4096n)
    );
  });

  test("an effect with no operation id stands alone", () => {
    const [bare] = inTransaction([{ type: "account_debited", account: MEDIATOR, amount: "1" }]);
    expect(transactionOf({ ...bare, paging_token: "x" })).toBe("x");
  });
});

describe("forwardFindings on a rotation's drain", () => {
  // The relay drain of the 2026-11-17 testnet rotation, 1b2ea80a…f282: the operator sources the
  // transaction, the retired relay merges into it. Its own effects carry the debit and the
  // removal; the merge's record, read by its operation id, carries the destination and source.
  const DRAIN_OP = "24829931787669506";
  const DRAIN_HASH = "1b2ea80a70265944e6335ce3173bc244dee9627ae44db0c3f35f851bdec5f282";
  const CREATED = "2026-11-17T15:31:31Z";
  const drain = (op = DRAIN_OP): HorizonAccountEffect[] => [
    {
      type: "account_debited",
      account: RETIRED_RELAY,
      amount: "10000.0000000",
      created_at: CREATED,
      paging_token: `${op}-1`,
    },
    {
      type: "account_removed",
      account: RETIRED_RELAY,
      created_at: CREATED,
      paging_token: `${op}-3`,
    },
  ];
  const mergeRecord = (
    into: string,
    txSource = OPERATOR,
    op = DRAIN_OP,
    source = RETIRED_RELAY
  ): HorizonOperation => ({
    type: "account_merge",
    source_account: source,
    into,
    transaction_hash: DRAIN_HASH,
    created_at: CREATED,
    paging_token: op,
    transaction: { source_account: txSource },
  });

  test("names each operation that removed the account, for a retired account only", () => {
    expect(removalOperations(retiredRelay, drain())).toEqual([DRAIN_OP]);
    expect(removalOperations({ ...retiredRelay, retired: undefined }, drain())).toEqual([]);
    expect(removalOperations({ ...retiredRelay, drainTo: undefined }, drain())).toEqual([]);
  });

  test("the runbook's drain into the operator is quiet", () => {
    expect(forwardFindings(retiredRelay, drain(), [mergeRecord(OPERATOR)])).toEqual([]);
  });

  test("the same merge into another address fires", () => {
    const [finding] = forwardFindings(retiredRelay, drain(), [mergeRecord(OTHER)]);
    expect(finding?.message).toContain("paid out 10000 XLM but the merge delivered 0 XLM");
  });

  test("a merge into the operator from a transaction it did not source fires", () => {
    expect(forwardFindings(retiredRelay, drain(), [mergeRecord(OPERATOR, OTHER)])).toHaveLength(1);
  });

  test("a merge of the current relay into the operator fires", () => {
    const current = { ...retiredRelay, retired: undefined };
    expect(forwardFindings(current, drain(), [mergeRecord(OPERATOR)])).toHaveLength(1);
  });

  test("a retired relay with no drain destination fires", () => {
    const unset = { ...retiredRelay, drainTo: undefined };
    expect(forwardFindings(unset, drain(), [mergeRecord(OPERATOR)])).toHaveLength(1);
  });

  test("a payment out next to the drain fires, in another operation", () => {
    const payout: HorizonAccountEffect[] = [
      {
        type: "account_debited",
        account: RETIRED_RELAY,
        amount: "5",
        created_at: CREATED,
        paging_token: `${BigInt(DRAIN_OP) + 1n}-2`,
      },
      ...drain(),
    ];
    const [finding] = forwardFindings(retiredRelay, payout, [mergeRecord(OPERATOR)]);
    expect(finding?.message).toContain("paid out 10005 XLM but the merge delivered 10000 XLM");
  });

  test("a merge into the operator in another operation does not offset the merge", () => {
    const other = String(BigInt(DRAIN_OP) + 1n);
    const records = [mergeRecord(OTHER), mergeRecord(OPERATOR, OPERATOR, other, OTHER)];
    expect(forwardFindings(retiredRelay, drain(), records)).toHaveLength(1);
  });

  test("effects with no operation to match fire", () => {
    const bare = drain().map((effect) => ({ ...effect, paging_token: "x" }));
    expect(forwardFindings(retiredRelay, bare, [mergeRecord(OPERATOR)])).toHaveLength(1);
  });

  test("a removal whose record could not be read is left unjudged, for the caller to report", () => {
    expect(forwardFindings(retiredRelay, drain(), [])).toEqual([]);
  });
});

describe("a retired fee sponsor", () => {
  // The sponsor drain of the 2026-11-17 testnet rotation, 6ccf2429…356f, as Horizon returns it.
  const DRAIN_OP = "24829936082640898";
  const CREATED = "2026-11-17T15:31:36Z";
  const drainEffects: HorizonAccountEffect[] = [
    {
      type: "account_debited",
      account: RETIRED_SPONSOR,
      amount: "9999.9998600",
      created_at: CREATED,
      paging_token: `${DRAIN_OP}-1`,
    },
    {
      type: "account_removed",
      account: RETIRED_SPONSOR,
      created_at: CREATED,
      paging_token: `${DRAIN_OP}-3`,
    },
  ];
  const mergeRecord = (into: string, txSource = OPERATOR): HorizonOperation => ({
    type: "account_merge",
    source_account: RETIRED_SPONSOR,
    into,
    transaction_hash: "6ccf2429bb1a8671b2c1a97ed8b00425b7f195996a6a72d512f50da3c898356f",
    created_at: CREATED,
    paging_token: DRAIN_OP,
    transaction: { source_account: txSource },
  });

  test("every account is read by the forward check through its own effects; only the current sponsor's every debit is a payout", () => {
    const accounts = loadServiceAccounts(
      { ...testnetEnv, FEE_ACCOUNT_ADDRESS_TESTNET_RETIRED: RETIRED_SPONSOR },
      testnetOnly,
      {}
    );
    expect(accountsFor(accounts, "forward")).toEqual([mediator, sponsor, retiredSponsor]);
    expect(accountsFor(accounts, "forward").map(anyDebitIsPayout)).toEqual([false, true, false]);
  });

  test("the runbook's drain into the operator is quiet", () => {
    expect(forwardFindings(retiredSponsor, drainEffects, [mergeRecord(OPERATOR)])).toEqual([]);
  });

  test("the same merge into another address fires", () => {
    const [finding] = forwardFindings(retiredSponsor, drainEffects, [mergeRecord(OTHER)]);
    expect(finding?.message).toContain("paid out 9999.99986 XLM but the merge delivered 0 XLM");
  });

  test("a payment out fires", () => {
    const payment = inTransaction(
      [{ type: "account_debited", account: RETIRED_SPONSOR, amount: "40" }],
      FORWARD_TX,
      CREATED
    );
    expect(forwardFindings(retiredSponsor, payment, [])).toHaveLength(1);
  });

  test("a fee bump it paid for raises nothing: a fee is not an effect", () => {
    // 52cb1ed3…37d0, a close the testnet sponsor paid the fee for: its effects never name it, so
    // the sponsor's own effects list holds nothing for it.
    const closer = "GA6CGRMFIHJCIXJJ7DSI6FD6DPEIA2LC2YMJJB7MDWXVY7FSAEQAX2WY";
    const effects = inTransaction(
      [
        { type: "account_debited", account: closer, amount: "1.0000000" },
        { type: "account_credited", account: OPERATOR, amount: "1.0000000" },
        { type: "account_removed", account: closer },
      ],
      24829644024844288n,
      "2026-11-17T15:25:56Z"
    );
    expect(forwardFindings({ ...retiredSponsor, address: SPONSOR }, effects, [])).toEqual([]);
  });
});

describe("keysFindings on operation sources", () => {
  const HASH = "c0ffee".padEnd(64, "0");
  const op = (
    fields: Pick<HorizonOperation, "type" | "source_account"> & Partial<HorizonOperation>,
    txSource: string = OTHER
  ): HorizonOperation => ({
    transaction_hash: HASH,
    created_at: "2026-11-17T15:24:51Z",
    paging_token: "1",
    transaction: { source_account: txSource },
    ...fields,
  });
  const sponsor: ServiceAccount = {
    role: "sponsor",
    network: "testnet",
    address: SPONSOR,
    floorXlm: "50",
  };
  const retiredRelay: ServiceAccount = {
    role: "mediator",
    network: "testnet",
    address: RETIRED_RELAY,
    floorXlm: "1",
    retired: true,
    drainTo: OPERATOR,
  };
  // The API's forward as the mediator's operations list returns it: the user merges into the
  // mediator and the mediator pays the exchange, in a transaction the user sourced.
  const forward = (relay: string, txSource = USER): HorizonOperation[] => [
    op({ type: "account_merge", source_account: txSource, into: relay }, txSource),
    op({ type: "payment", source_account: relay, asset_type: "native" }, txSource),
  ];

  test.each([
    ["set_options", "relay", mediator],
    ["change_trust", "relay", mediator],
    ["payment", "relay", mediator],
    ["payment", "sponsor", sponsor],
    ["set_options", "retired relay", retiredRelay],
    ["change_trust", "retired relay", retiredRelay],
  ] as const)(
    "a %s sourced by the %s inside someone else's transaction fires",
    (type, _, account) => {
      const findings = keysFindings(account, [], [op({ type, source_account: account.address })]);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain(`transaction ${HASH}`);
      expect(findings[0].message).toContain(`operations sourced from the account: ${type}`);
    }
  );

  test("the API's forward is quiet, from the current and from a retired relay", () => {
    expect(keysFindings(mediator, [], forward(MEDIATOR))).toEqual([]);
    expect(keysFindings(retiredRelay, [], forward(RETIRED_RELAY))).toEqual([]);
  });

  test("a native payment by the relay with no merge into it fires", () => {
    const [, payment] = forward(MEDIATOR);
    expect(keysFindings(mediator, [], [payment])).toHaveLength(1);
  });

  test("a payment of another asset in the forward's shape fires", () => {
    const [merge, payment] = forward(MEDIATOR);
    const credit = { ...payment, asset_type: "credit_alphanum4" };
    expect(keysFindings(mediator, [], [merge, credit])).toHaveLength(1);
  });

  test("the sponsor has no forward to excuse", () => {
    expect(keysFindings(sponsor, [], forward(SPONSOR))).toHaveLength(1);
  });

  test("an operation with no transaction joined fires", () => {
    const bare = forward(MEDIATOR).map((o) => ({ ...o, transaction: undefined }));
    expect(keysFindings(mediator, [], bare)).toHaveLength(1);
  });

  describe("the rotation's drain", () => {
    // 1b2ea80a…f282: the operator bumps its own sequence and the retired relay merges into it.
    const drain = (into: string, txSource = OPERATOR): HorizonOperation[] => [
      op({ type: "bump_sequence", source_account: txSource }, txSource),
      op({ type: "account_merge", source_account: RETIRED_RELAY, into }, txSource),
    ];

    test("is quiet", () => {
      expect(keysFindings(retiredRelay, [], drain(OPERATOR))).toEqual([]);
    });

    test("into another address fires", () => {
      expect(keysFindings(retiredRelay, [], drain(OTHER))).toHaveLength(1);
    });

    test("in a transaction the operator did not source fires", () => {
      expect(keysFindings(retiredRelay, [], drain(OPERATOR, OTHER))).toHaveLength(1);
    });

    test("of the current relay fires", () => {
      const current = { ...retiredRelay, address: MEDIATOR, retired: undefined };
      const merge = op(
        { type: "account_merge", source_account: MEDIATOR, into: OPERATOR },
        OPERATOR
      );
      expect(keysFindings(current, [], [merge])).toHaveLength(1);
    });
  });

  test("a transaction the account sourced is reported once", () => {
    const sourced = { ...tx, hash: HASH, source_account: MEDIATOR };
    const own = op({ type: "set_options", source_account: MEDIATOR }, MEDIATOR);
    const findings = keysFindings(mediator, [sourced], [own]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("is sourced from the account");
  });

  test("operations from separate transactions are judged separately", () => {
    const [merge] = forward(MEDIATOR);
    const payment = {
      ...forward(MEDIATOR)[1],
      transaction_hash: "beef".padEnd(64, "0"),
    };
    expect(keysFindings(mediator, [], [merge, payment])).toHaveLength(1);
  });

  test("operationsInWindow joins each transaction and keeps failed ones", async () => {
    const paths: string[] = [];
    await operationsInWindow(
      async (path) => {
        paths.push(path);
        return { _embedded: { records: [] } };
      },
      MEDIATOR,
      new Date(0)
    );
    const [path, query] = paths[0].split("?");
    expect(path).toBe(`/accounts/${MEDIATOR}/operations`);
    const params = new URLSearchParams(query);
    expect(params.get("join")).toBe("transactions");
    expect(params.get("include_failed")).toBe("true");
    expect(params.get("order")).toBe("desc");
  });
});

// A native asset contract transfer out of a G account, sourced by another account and authorized by
// the debited account's Soroban auth entry, as Horizon returned it on testnet on 2026-11-18
// (2cc82275…be05, between throwaway accounts). Here the debited account is a service account.
const SAC_TX = "2cc8227570c45b043d6e1a3d20d8df3e80e7819214eaed2ed97e509f019ebe05";
const SAC_OP = "24867761859633153";
const CALLER = "GCSZJYLNOWJQ2SLQHJFLP2CSYO5X2N64BZEUPTHDMBM6PMDJLXT3VHRD";
const contractTransfer = (from: string, to = CALLER): HorizonOperation => ({
  type: "invoke_host_function",
  source_account: CALLER,
  transaction_hash: SAC_TX,
  created_at: "2026-11-18T03:45:31Z",
  paging_token: SAC_OP,
  transaction: { source_account: CALLER },
  asset_balance_changes: [
    { asset_type: "native", type: "transfer", from, to, amount: "1.0000000" },
  ],
});

const sponsor: ServiceAccount = {
  role: "sponsor",
  network: "testnet",
  address: SPONSOR,
  floorXlm: "50",
};
const retiredRelay: ServiceAccount = {
  role: "mediator",
  network: "testnet",
  address: RETIRED_RELAY,
  floorXlm: "1",
  retired: true,
  drainTo: OPERATOR,
};
const retiredSponsor: ServiceAccount = {
  role: "sponsor",
  network: "testnet",
  address: RETIRED_SPONSOR,
  floorXlm: "50",
  retired: true,
  drainTo: OPERATOR,
};

describe("keysFindings on Soroban authorization", () => {
  test.each([
    ["relay", mediator],
    ["sponsor", sponsor],
    ["retired relay", retiredRelay],
    ["retired sponsor", retiredSponsor],
  ] as const)("an asset contract transfer out of the %s fires", (_, account) => {
    const findings = keysFindings(account, [], [contractTransfer(account.address)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      `transaction ${SAC_TX} (2026-11-18T03:45:31Z) moved 1.0000000 XLM out of the account ` +
        `through a contract call sourced by ${CALLER}, authorized by its key. Expected none.`
    );
  });

  test("a transfer_from after an approve fires: the debited account is still `from`", () => {
    // ad6a830b…343c: the spender sources the call, the approve before it named no account.
    const spent = {
      ...contractTransfer(SPONSOR),
      transaction_hash: "ad6a830b0ef4107fda8f952f55a468e65d4ac61dbb117fecb88d0a22522d343c",
    };
    expect(keysFindings(sponsor, [], [spent])).toHaveLength(1);
  });

  test("a transfer into the account is quiet", () => {
    expect(keysFindings(sponsor, [], [contractTransfer(CALLER, SPONSOR)])).toEqual([]);
    expect(keysFindings(mediator, [], [contractTransfer(CALLER, MEDIATOR)])).toEqual([]);
  });

  test("a contract call that moved nothing is quiet", () => {
    const call = { ...contractTransfer(SPONSOR), asset_balance_changes: null };
    expect(keysFindings(sponsor, [], [call])).toEqual([]);
  });

  test("names every asset the call moved out of the account", () => {
    const call = contractTransfer(SPONSOR);
    call.asset_balance_changes!.push({
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      type: "transfer",
      from: SPONSOR,
      to: CALLER,
      amount: "3.0000000",
    });
    expect(keysFindings(sponsor, [], [call])[0].message).toContain(
      "moved 1.0000000 XLM, 3.0000000 USDC out of the account"
    );
  });

  test("a transaction with an operation the account sourced is reported once", () => {
    const own: HorizonOperation = {
      ...contractTransfer(CALLER),
      type: "set_options",
      source_account: SPONSOR,
      asset_balance_changes: undefined,
    };
    const findings = keysFindings(sponsor, [], [own, contractTransfer(SPONSOR)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("operations sourced from the account: set_options");
  });
});

describe("keysFindings on the fee account", () => {
  // 7eb757ae…c7c4 and its failed twin 16038283…ac88 on testnet, 2026-11-18: a fee bump lists the
  // inner transaction's source as source_account and the payer as fee_account.
  const INNER = "GB6UNK7IIYB2J2CTM2IHEKDIB3D6IMWMPTOA4J63E6XVAC7OOSGNAT5I";
  const feeBump = (payer: string): HorizonTransaction => ({
    hash: "7eb757ae47403531b980ef13f539dbe61c22437ba072097c44bf7c678101c7c4",
    created_at: "2026-11-18T03:45:56Z",
    source_account: INNER,
    fee_account: payer,
    paging_token: "24867817935101952",
  });
  const failedFeeBump = (payer: string): HorizonTransaction => ({
    ...feeBump(payer),
    hash: "16038283958ea4554074a682e803622ec714353d787878f936da1454ac50ac88",
  });

  test.each([
    ["relay", mediator],
    ["retired relay", retiredRelay],
  ] as const)("a fee bump the %s paid for fires, failed or not", (_, account) => {
    const findings = keysFindings(
      account,
      [feeBump(account.address), failedFeeBump(account.address)],
      []
    );
    expect(findings.map((f) => f.message)).toEqual([
      `transaction ${feeBump("").hash} (2026-11-18T03:45:56Z) is a fee bump the account paid ` +
        `for, sourced by ${INNER}. Expected none: the relay never pays a fee.`,
      expect.stringContaining(failedFeeBump("").hash),
    ]);
  });

  test("the sponsor's own fee bumps, failed or not, are quiet", () => {
    expect(keysFindings(sponsor, [feeBump(SPONSOR), failedFeeBump(SPONSOR)], [])).toEqual([]);
  });

  test("a retired sponsor's fee bumps are not judged: the window holds the ones before the switch", () => {
    expect(keysFindings(retiredSponsor, [feeBump(RETIRED_SPONSOR)], [])).toEqual([]);
  });

  test("a transaction the relay sourced and paid for is reported once, as sourced", () => {
    const own = { ...feeBump(MEDIATOR), source_account: MEDIATOR };
    const findings = keysFindings(mediator, [own], []);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("is sourced from the account");
  });

  test("a transaction the relay only takes part in is quiet", () => {
    expect(keysFindings(mediator, [{ ...tx, fee_account: USER }], [])).toEqual([]);
  });

  test("transactionsInWindow keeps failed transactions only when asked", async () => {
    const paths: string[] = [];
    const get = async (path: string): Promise<HorizonTransactionPage> => {
      paths.push(path);
      return { _embedded: { records: [] } };
    };
    await transactionsInWindow(get, MEDIATOR, new Date(0));
    await transactionsInWindow(get, MEDIATOR, new Date(0), 25, true);
    expect(new URLSearchParams(paths[0].split("?")[1]).has("include_failed")).toBe(false);
    expect(new URLSearchParams(paths[1].split("?")[1]).get("include_failed")).toBe("true");
  });
});

describe("the current sponsor's debits", () => {
  const effect = (fields: Partial<HorizonAccountEffect>): HorizonAccountEffect => ({
    type: "account_debited",
    account: SPONSOR,
    amount: "1.0000000",
    asset_type: "native",
    created_at: "2026-11-18T03:45:31Z",
    paging_token: `${SAC_OP}-1`,
    ...fields,
  });

  test("an asset contract transfer out of it fires, named by its operation", () => {
    expect(sponsorDebitFindings(sponsor, [effect({})]).map((f) => f.message)).toEqual([
      `operation ${SAC_OP} (2026-11-18T03:45:31Z) debited 1.0000000 XLM from the account. ` +
        "Expected none: the sponsor only pays fees, and a fee is not an effect.",
    ]);
  });

  test("one finding per operation", () => {
    const effects = [
      effect({ paging_token: "5-1" }),
      effect({ paging_token: "5-3", asset_type: "credit_alphanum4", asset_code: "USDC" }),
      effect({ paging_token: "6-1" }),
    ];
    const findings = sponsorDebitFindings(sponsor, effects);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain("operation 5 ");
    expect(findings[0].message).toContain("debited 1.0000000 XLM, 1.0000000 USDC");
  });

  test("its creation, a top-up and effects on other accounts are quiet", () => {
    // The testnet sponsor's whole effects list, plus an operator top-up and someone else's debit.
    const effects = [
      effect({ type: "account_created", amount: undefined, paging_token: "9-1" }),
      effect({ type: "signer_created", amount: undefined, paging_token: "9-2" }),
      effect({ type: "account_credited", amount: "100.0000000", paging_token: "10-1" }),
      effect({ account: OPERATOR, paging_token: "10-2" }),
    ];
    expect(sponsorDebitFindings(sponsor, effects)).toEqual([]);
  });

  test("effectsInWindow reads the account's own effects list in the window", async () => {
    const paths: string[] = [];
    const records = [
      effect({ created_at: "2026-11-18T03:45:31Z" }),
      effect({ created_at: "2026-11-01T00:00:00Z", paging_token: "1-1" }),
    ];
    const result = await effectsInWindow(
      async (path) => {
        paths.push(path);
        return { _embedded: { records } };
      },
      SPONSOR,
      new Date("2026-11-11T00:00:00Z")
    );
    expect(paths).toEqual([`/accounts/${SPONSOR}/effects?limit=200&order=desc`]);
    expect(result).toEqual({ records: [records[0]], complete: true });
  });

  test("the relay's forward check fires on the same transfer: no merge delivered it", () => {
    const debit = effect({ account: MEDIATOR });
    expect(forwardFindings(mediator, [debit], [])[0]?.message).toContain(
      "paid out 1 XLM but the merge delivered 0 XLM"
    );
  });
});

describe("checkStatus", () => {
  const finding = { account: mediator, message: "fired" };
  const unread = { account: mediator, message: "stopped" };

  test("nothing fired and everything was read: clean", () => {
    expect(checkStatus([], [])).toBe("clean");
  });

  test("something could not be read and nothing fired: incomplete, never clean", () => {
    expect(checkStatus([], [unread])).toBe("incomplete");
  });

  test("a finding is a finding whatever else went unread", () => {
    expect(checkStatus([finding], [])).toBe("finding");
    expect(checkStatus([finding], [unread])).toBe("finding");
  });
});

describe("a read that stopped inside a transaction", () => {
  // The API's forward, newest operation first as Horizon lists it: the payment (op 2) comes
  // before the merge into the relay (op 1), so a read that stops between them holds only the
  // payment.
  const FORWARD_HASH = "6065aa4ae0dc33d7a847f87b24aed3d1131bd413d2674f9088f947b90b114267";
  const op = (fields: Partial<HorizonOperation>): HorizonOperation => ({
    type: "payment",
    source_account: MEDIATOR,
    asset_type: "native",
    transaction_hash: FORWARD_HASH,
    created_at: "2026-11-17T15:24:51Z",
    paging_token: "2",
    transaction: { source_account: USER },
    ...fields,
  });
  const payment = op({});
  const setOptions = op({
    type: "set_options",
    transaction_hash: "c0ffee".padEnd(64, "0"),
    paging_token: "9",
  });

  test("keys: a forward's payment without its merge is left out, so nothing fires", () => {
    const cut = { records: [payment], complete: false, stopped: "the 1-page cap was reached" };
    expect(keysFindings(mediator, [], [payment])).toHaveLength(1);
    expect(
      keysFindings(
        mediator,
        [],
        wholeTransactions(cut, (o) => o.transaction_hash)
      )
    ).toEqual([]);
    const findings = keysFindings(
      mediator,
      [],
      wholeTransactions(cut, (o) => o.transaction_hash)
    );
    expect(checkStatus(findings, [incompleteRead(mediator, 168, "operations", { count: 1 })])).toBe(
      "incomplete"
    );
  });

  test("keys: a finding in a transaction read in full still fires when the read stopped later", () => {
    const cut = { records: [setOptions, payment], complete: false, stopped: "Horizon timed out" };
    const findings = keysFindings(
      mediator,
      [],
      wholeTransactions(cut, (o) => o.transaction_hash)
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("set_options");
    expect(checkStatus(findings, [incompleteRead(mediator, 168, "operations", { count: 2 })])).toBe(
      "finding"
    );
  });

  test("a complete read keeps its oldest transaction", () => {
    const whole = { records: [setOptions, payment], complete: true };
    expect(wholeTransactions(whole, (o) => o.transaction_hash)).toEqual([setOptions, payment]);
  });

  // The same forward in the relay's own effects: the debit (op …634) before the credit (op …633).
  const debit: HorizonAccountEffect = {
    type: "account_debited",
    account: MEDIATOR,
    amount: "9999.9999800",
    created_at: "2026-11-17T15:24:51Z",
    paging_token: "24829588190277634-2",
  };
  const credit: HorizonAccountEffect = {
    ...debit,
    type: "account_credited",
    paging_token: "24829588190277633-2",
  };
  const payout: HorizonAccountEffect = {
    ...debit,
    amount: "5",
    created_at: "2026-11-17T16:00:00Z",
    paging_token: "24829600000004097-1",
  };

  test("forward: a debit without the credit before it is left out, so nothing fires", () => {
    const cut = { records: [debit], complete: false, stopped: "the 1-page cap was reached" };
    expect(forwardFindings(mediator, [debit], [])).toHaveLength(1);
    const findings = forwardFindings(mediator, wholeTransactions(cut, transactionOf), []);
    expect(findings).toEqual([]);
    expect(checkStatus(findings, [incompleteRead(mediator, 168, "effects", { count: 1 })])).toBe(
      "incomplete"
    );
  });

  test("forward: a payout in a transaction read in full still fires when the read stopped later", () => {
    const cut = { records: [payout, debit], complete: false, stopped: "Horizon timed out" };
    const findings = forwardFindings(mediator, wholeTransactions(cut, transactionOf), []);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("paid out 5 XLM");
    expect(checkStatus(findings, [incompleteRead(mediator, 168, "effects", { count: 2 })])).toBe(
      "finding"
    );
  });

  test("forward: the whole forward read in full is quiet", () => {
    const whole = { records: [debit, credit], complete: true };
    expect(forwardFindings(mediator, wholeTransactions(whole, transactionOf), [])).toEqual([]);
  });
});

describe("sequenceFinding", () => {
  const since = new Date("2026-11-11T00:00:00Z");
  const record = (sequenceTime: string | null | undefined) => ({
    balances: [],
    sequence_time: sequenceTime,
  });

  test("a sequence that moved inside the window fires", () => {
    const at = String(Date.parse("2026-11-17T15:30:00Z") / 1000);
    expect(sequenceFinding(mediator, record(at), since)?.message).toContain(
      "its sequence number moved at 2026-11-17T15:30:00.000Z"
    );
  });

  test("a sequence that moved exactly at the window start fires", () => {
    expect(sequenceFinding(mediator, record(String(since.getTime() / 1000)), since)).not.toBeNull();
  });

  test("a sequence that last moved before the window is quiet", () => {
    expect(sequenceFinding(mediator, record(String(since.getTime() / 1000 - 1)), since)).toBeNull();
  });

  test("a sequence that never moved is quiet, as Horizon shows the testnet relay and sponsor", () => {
    expect(sequenceFinding(mediator, record(null), since)).toBeNull();
    expect(sequenceFinding(sponsor, record(undefined), since)).toBeNull();
  });

  test("keysFindings reports it when the history read found nothing, and only then", () => {
    const moved = sequenceFinding(mediator, record(String(since.getTime() / 1000)), since);
    expect(keysFindings(mediator, [], [], moved)).toEqual([moved!]);
    const sourced = { ...tx, source_account: MEDIATOR };
    const findings = keysFindings(mediator, [sourced], [], moved);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("is sourced from the account");
    expect(keysFindings(mediator, [], [], null)).toEqual([]);
  });
});
