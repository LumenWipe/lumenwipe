/**
 * Runs the service-account monitors of docs/monitoring-plan.md section 4 against Horizon and
 * exits non-zero on any finding. Read-only: no account, no transaction, no secret.
 *
 *   SERVICE_ACCOUNTS='[{"role":"mediator","network":"testnet","address":"G...","floorXlm":"1"}]' \
 *     bun run scripts/monitors/service-accounts.ts balances|forward
 */
import {
  balanceFinding,
  forwardFinding,
  formatFinding,
  parseServiceAccounts,
  type Finding,
  type HorizonAccount,
  type HorizonEffect,
  type HorizonTransaction,
  type ServiceAccount,
  type ServiceNetwork,
} from "@/lib/monitors/service-accounts";

const HORIZON: Record<ServiceNetwork, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

async function horizon<T>(network: ServiceNetwork, path: string): Promise<T> {
  const res = await fetch(`${HORIZON[network]}${path}`);
  // An endpoint problem must fail loudly, never read as "nothing to report".
  if (!res.ok) throw new Error(`Horizon ${network} returned ${res.status} for ${path}`);
  return (await res.json()) as T;
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

async function forward(accounts: ServiceAccount[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const account of accounts.filter((a) => a.role === "mediator")) {
    const page = await horizon<{ _embedded: { records: HorizonTransaction[] } }>(
      account.network,
      `/accounts/${account.address}/transactions?limit=200&order=desc`
    );
    for (const tx of page._embedded.records) {
      const effects = await horizon<{ _embedded: { records: HorizonEffect[] } }>(
        account.network,
        `/transactions/${tx.hash}/effects?limit=200`
      );
      const finding = forwardFinding(account, tx, effects._embedded.records);
      if (finding) findings.push(finding);
    }
    console.log(
      `${account.role} (${account.network}): ${page._embedded.records.length} transactions checked`
    );
  }
  return findings;
}

const check = process.argv[2];
const accounts = parseServiceAccounts(process.env.SERVICE_ACCOUNTS ?? "");
const findings = await (check === "balances"
  ? balances(accounts)
  : check === "forward"
    ? forward(accounts)
    : Promise.reject(new Error(`unknown check "${check}"; expected balances or forward`)));

for (const finding of findings) console.error(`::error::${formatFinding(finding)}`);
process.exit(findings.length === 0 ? 0 : 1);
