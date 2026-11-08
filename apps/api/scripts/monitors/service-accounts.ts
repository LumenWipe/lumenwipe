/**
 * Runs the service-account monitors of docs/monitoring-plan.md section 4 against Horizon and
 * exits non-zero on any finding. Read-only: no account, no transaction, no secret.
 *
 *   MEDIATOR_ADDRESS_TESTNET=G... FEE_ACCOUNT_ADDRESS_TESTNET=G... \
 *     bun run scripts/monitors/service-accounts.ts config|keys|balances|forward
 *
 * MEDIATOR_ADDRESS_MAINNET and FEE_ACCOUNT_ADDRESS_MAINNET add mainnet; MONITOR_HISTORY_HOURS
 * sets how far back keys and forward read.
 */
import { readFileSync } from "node:fs";
import {
  balanceFinding,
  forwardFinding,
  formatFinding,
  historyWindowHours,
  incompleteHistoryFinding,
  loadServiceAccounts,
  plannedAccounts,
  sourcedFinding,
  transactionsInWindow,
  type Finding,
  type HorizonAccount,
  type HorizonEffect,
  type HorizonTransactionPage,
  type ServiceAccount,
  type ServiceNetwork,
} from "@/lib/monitors/service-accounts";

const HORIZON: Record<ServiceNetwork, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

/** Effects are read one transaction at a time, this far apart, so a busy account cannot burst Horizon. */
const EFFECTS_DELAY_MS = 100;

const ROOT = new URL("../../../../", import.meta.url);

let requests = 0;

async function horizon<T>(network: ServiceNetwork, path: string): Promise<T> {
  requests++;
  const res = await fetch(`${HORIZON[network]}${path}`);
  // An endpoint problem must fail loudly, never read as "nothing to report".
  if (!res.ok) throw new Error(`Horizon ${network} returned ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function history(account: ServiceAccount, hours: number, findings: Finding[]) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const result = await transactionsInWindow(
    (path) => horizon<HorizonTransactionPage>(account.network, path),
    account.address,
    since
  );
  if (!result.complete) findings.push(incompleteHistoryFinding(account, hours));
  return result.transactions;
}

async function keys(accounts: ServiceAccount[], hours: number): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const account of accounts) {
    const transactions = await history(account, hours, findings);
    let sourced = 0;
    for (const tx of transactions) {
      const finding = sourcedFinding(account, tx);
      if (finding) {
        findings.push(finding);
        sourced++;
      }
    }
    console.log(
      `${account.role} (${account.network}): ${sourced} of ${transactions.length} transactions in the last ${hours} h sourced from it`
    );
  }
  return findings;
}

async function balances(accounts: ServiceAccount[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const account of accounts) {
    const record = await horizon<HorizonAccount>(account.network, `/accounts/${account.address}`);
    const finding = balanceFinding(account, record);
    if (finding) findings.push(finding);
    else
      console.log(
        `${account.role} (${account.network}): balance at or above ${account.floorXlm} XLM`
      );
  }
  return findings;
}

async function forward(accounts: ServiceAccount[], hours: number): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const account of accounts.filter((a) => a.role === "mediator")) {
    const transactions = await history(account, hours, findings);
    for (const tx of transactions) {
      await Bun.sleep(EFFECTS_DELAY_MS);
      const effects = await horizon<{ _embedded: { records: HorizonEffect[] } }>(
        account.network,
        `/transactions/${tx.hash}/effects?limit=200`
      );
      const finding = forwardFinding(account, tx, effects._embedded.records);
      if (finding) findings.push(finding);
    }
    console.log(
      `${account.role} (${account.network}): ${transactions.length} transactions in the last ${hours} h checked`
    );
  }
  return findings;
}

async function run(check: string | undefined): Promise<Finding[]> {
  const plan = plannedAccounts(readFileSync(new URL("docs/monitoring-plan.md", ROOT), "utf8"));
  const toml = Bun.TOML.parse(
    readFileSync(new URL("apps/web/public/.well-known/stellar.toml", ROOT), "utf8")
  );
  const accounts = loadServiceAccounts(process.env, plan, toml);
  const hours = historyWindowHours(process.env.MONITOR_HISTORY_HOURS);
  switch (check) {
    case "config":
      for (const a of accounts) console.log(`${a.role} (${a.network}): ${a.address}`);
      console.log(`History window: ${hours} h. Variables, plan and stellar.toml agree.`);
      return [];
    case "keys":
      return keys(accounts, hours);
    case "balances":
      return balances(accounts);
    case "forward":
      return forward(accounts, hours);
    default:
      throw new Error(`unknown check "${check}"; expected config, keys, balances or forward`);
  }
}

try {
  const findings = await run(process.argv[2]);
  console.log(`${requests} Horizon requests`);
  for (const finding of findings) console.error(`::error::${formatFinding(finding)}`);
  process.exit(findings.length === 0 ? 0 : 1);
} catch (error) {
  // A configuration or endpoint problem means the check did not run: that fails the run too.
  for (const line of (error as Error).message.split("\n")) console.error(`::error::${line}`);
  process.exit(1);
}
