/**
 * Runs the service-account monitors of docs/monitoring-plan.md section 4 against Horizon. Read-only:
 * no account, no transaction, no secret.
 *
 *   MEDIATOR_ADDRESS_TESTNET=G... FEE_ACCOUNT_ADDRESS_TESTNET=G... \
 *     bun run scripts/monitors/service-accounts.ts config|keys|balances|forward
 *
 * MEDIATOR_ADDRESS_MAINNET and FEE_ACCOUNT_ADDRESS_MAINNET add mainnet; MONITOR_HISTORY_HOURS
 * sets how far back keys and forward read. Each variable with a _RETIRED suffix adds an address
 * rotated out, read by keys and forward only. OPERATOR_ADDRESS_TESTNET and _MAINNET name the
 * account a rotation drains a retired address into.
 *
 * Exits 0 only when the check is clean. In a workflow it also writes `status` to GITHUB_OUTPUT:
 * `finding` when a condition fired, `incomplete` when nothing fired but something could not be
 * read, `clean` otherwise. Only a finding pages everyone.
 */
import { appendFileSync, readFileSync } from "node:fs";
import {
  accountsFor,
  anyDebitIsPayout,
  balanceFinding,
  checkStatus,
  effectsInWindow,
  formatFinding,
  forwardFindings,
  historyWindowHours,
  incompleteRead,
  keysFindings,
  loadServiceAccounts,
  operationsInWindow,
  plannedAccounts,
  removalOperations,
  roleLabel,
  sequenceFinding,
  sponsorDebitFindings,
  transactionOf,
  transactionsInWindow,
  wholeTransactions,
  MAX_HISTORY_PAGES,
  type CheckStatus,
  type Finding,
  type HorizonAccount,
  type HorizonAccountEffectPage,
  type HorizonOperation,
  type HorizonOperationPage,
  type HorizonTransactionPage,
  type ServiceAccount,
  type ServiceNetwork,
} from "@/lib/monitors/service-accounts";

const HORIZON: Record<ServiceNetwork, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

/** A Horizon request that hangs ends the read rather than the job's timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Each check stops reading after this long and reports what it did not read, so every step ends
 * on its own well inside the job's timeout (the sum is in onchain-monitors.yml). Every account
 * gets an equal share, so a flood on one cannot spend another's.
 */
const CHECK_BUDGET_MS = 4 * 60_000;

const ROOT = new URL("../../../../", import.meta.url);

/** Smaller limits than the defaults, for a run that has to show an incomplete read. */
export interface RunOptions {
  maxPages?: number;
  budgetMs?: number;
}

class Run {
  readonly findings: Finding[] = [];
  readonly incomplete: Finding[] = [];
  requests = 0;
  /** The current account's share of the budget, while `each` reads it. */
  private deadline: AbortSignal | null = null;
  private shareMs = 0;

  constructor(
    readonly hours: number,
    readonly maxPages: number,
    private readonly budgetMs: number
  ) {}

  get since(): Date {
    return new Date(Date.now() - this.hours * 3_600_000);
  }

  async horizon<T>(network: ServiceNetwork, path: string): Promise<T> {
    const res = await this.fetch(network, path);
    // An endpoint problem must never read as "nothing to report".
    if (!res.ok) throw new Error(`Horizon ${network} returned ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  /**
   * Every account's record at once, before any history and outside the budget, with only the
   * per-request timeout: the sequence read is what a flood of history cannot crowd out. Undefined
   * for an account whose record could not be read, which is reported unread.
   */
  async records(accounts: ServiceAccount[]): Promise<Map<ServiceAccount, HorizonAccount | null>> {
    const read = await Promise.all(
      accounts.map(async (account) => {
        try {
          return [account, await this.account(account)] as const;
        } catch (error) {
          this.unreadable(account, `its sequence could not be read: ${(error as Error).message}`);
          return null;
        }
      })
    );
    return new Map(read.filter((entry) => entry !== null));
  }

  /** The account record, or null for a retired account its drain already removed. */
  private async account(account: ServiceAccount): Promise<HorizonAccount | null> {
    const path = `/accounts/${account.address}`;
    const res = await this.fetch(account.network, path);
    if (account.retired === true && res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon ${account.network} returned ${res.status} for ${path}`);
    return (await res.json()) as HorizonAccount;
  }

  private async fetch(network: ServiceNetwork, path: string): Promise<Response> {
    const deadline = this.deadline;
    if (deadline?.aborted) throw new Error(this.budgetSpent());
    this.requests++;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${HORIZON[network]}${path}`, {
        signal: deadline === null ? timeout : AbortSignal.any([timeout, deadline]),
      });
    } catch {
      throw new Error(
        deadline?.aborted
          ? this.budgetSpent()
          : `Horizon ${network} did not answer ${path} within ${REQUEST_TIMEOUT_MS / 1000} s`
      );
    }
  }

  private budgetSpent(): string {
    return (
      `its ${this.shareMs / 1000} s share of the check's ${this.budgetMs / 1000} s time budget ` +
      "ran out"
    );
  }

  /**
   * Reads each account in turn, each within an equal share of the budget; one that fails is
   * reported unread and the next one still runs.
   */
  async each(accounts: ServiceAccount[], read: (account: ServiceAccount) => Promise<void>) {
    this.shareMs = this.budgetMs / Math.max(accounts.length, 1);
    for (const account of accounts) {
      this.deadline = AbortSignal.timeout(this.shareMs);
      try {
        await read(account);
      } catch (error) {
        this.unreadable(account, `could not be read: ${(error as Error).message}`);
      } finally {
        this.deadline = null;
      }
    }
  }

  unreadable(account: ServiceAccount, message: string) {
    this.incomplete.push({ account, message });
  }

  /** Reports a list read short of the window start. */
  stoppedShort(
    account: ServiceAccount,
    list: string,
    read: { complete: boolean; stopped?: string },
    count: number
  ) {
    if (read.complete) return;
    this.incomplete.push(
      incompleteRead(account, this.hours, list, { count, stopped: read.stopped })
    );
  }
}

function log(line: string) {
  process.stdout.write(`${line}\n`);
}

async function keys(run: Run, accounts: ServiceAccount[]) {
  const watched = accountsFor(accounts, "keys");
  const records = await run.records(watched);
  await run.each(watched, async (account) => {
    const since = run.since;
    const record = records.get(account) ?? null;
    const transactions = await transactionsInWindow(
      (path) => run.horizon<HorizonTransactionPage>(account.network, path),
      account.address,
      since,
      run.maxPages,
      true
    );
    run.stoppedShort(account, "transactions", transactions, transactions.transactions.length);
    const operations = await operationsInWindow(
      (path) => run.horizon<HorizonOperationPage>(account.network, path),
      account.address,
      since,
      run.maxPages
    );
    run.stoppedShort(account, "operations", operations, operations.records.length);
    const found = keysFindings(
      account,
      transactions.transactions,
      wholeTransactions(operations, (op) => op.transaction_hash),
      record === null ? null : sequenceFinding(account, record, since)
    );
    run.findings.push(...found);
    log(
      `${roleLabel(account)} (${account.network}): ${found.length} uses of its key in the last ` +
        `${run.hours} h beyond the forward and the drain: as source, sequence, operation source, ` +
        "contract debit or relay fee account " +
        `(${transactions.transactions.length} transactions and ${operations.records.length} operations read)`
    );
  });
}

async function balances(run: Run, accounts: ServiceAccount[]) {
  await run.each(accountsFor(accounts, "balances"), async (account) => {
    const record = await run.horizon<HorizonAccount>(
      account.network,
      `/accounts/${account.address}`
    );
    const finding = balanceFinding(account, record);
    if (finding) run.findings.push(finding);
    else
      log(
        `${roleLabel(account)} (${account.network}): balance at or above ${account.floorXlm} XLM`
      );
  });
}

async function forward(run: Run, accounts: ServiceAccount[]) {
  await run.each(accountsFor(accounts, "forward"), async (account) => {
    const effects = await effectsInWindow(
      (path) => run.horizon<HorizonAccountEffectPage>(account.network, path),
      account.address,
      run.since,
      run.maxPages
    );
    run.stoppedShort(account, "effects", effects, effects.records.length);
    if (anyDebitIsPayout(account)) {
      const found = sponsorDebitFindings(account, effects.records);
      run.findings.push(...found);
      log(
        `${roleLabel(account)} (${account.network}): ${effects.records.length} effects in the last ` +
          `${run.hours} h checked, ${found.length} debits`
      );
      return;
    }
    const judged = wholeTransactions(effects, transactionOf);
    const removals: HorizonOperation[] = [];
    for (const operation of removalOperations(account, judged)) {
      try {
        removals.push(
          await run.horizon<HorizonOperation>(
            account.network,
            `/operations/${operation}?join=transactions`
          )
        );
      } catch (error) {
        run.unreadable(
          account,
          `operation ${operation} removed the account and could not be read to tell the ` +
            `rotation's drain from a payout: ${(error as Error).message}`
        );
      }
    }
    const found = forwardFindings(account, judged, removals);
    run.findings.push(...found);
    log(
      `${roleLabel(account)} (${account.network}): ${effects.records.length} effects in the last ` +
        `${run.hours} h checked, ${found.length} transactions paid out beyond the merge`
    );
  });
}

export async function main(check: string | undefined, options: RunOptions = {}): Promise<number> {
  let run: Run | undefined;
  let status: CheckStatus;
  try {
    const plan = plannedAccounts(readFileSync(new URL("docs/monitoring-plan.md", ROOT), "utf8"));
    const toml = Bun.TOML.parse(
      readFileSync(new URL("apps/web/public/.well-known/stellar.toml", ROOT), "utf8")
    );
    const accounts = loadServiceAccounts(process.env, plan, toml);
    const hours = historyWindowHours(process.env.MONITOR_HISTORY_HOURS);
    run = new Run(
      hours,
      options.maxPages ?? MAX_HISTORY_PAGES,
      options.budgetMs ?? CHECK_BUDGET_MS
    );
    switch (check) {
      case "config":
        for (const a of accounts) {
          const drain = a.drainTo === undefined ? "" : `, drained into ${a.drainTo}`;
          log(`${roleLabel(a)} (${a.network}): ${a.address}${drain}`);
        }
        log(`History window: ${hours} h. Variables, plan and stellar.toml agree.`);
        break;
      case "keys":
        await keys(run, accounts);
        break;
      case "balances":
        await balances(run, accounts);
        break;
      case "forward":
        await forward(run, accounts);
        break;
      default:
        throw new Error(`unknown check "${check}"; expected config, keys, balances or forward`);
    }
    log(`${run.requests} Horizon requests`);
    status = checkStatus(run.findings, run.incomplete);
  } catch (error) {
    // A check that did not finish is never clean, and a finding already made still pages.
    for (const line of (error as Error).message.split("\n")) {
      process.stderr.write(`::error::${line}\n`);
    }
    status = run !== undefined && run.findings.length > 0 ? "finding" : "incomplete";
  }
  for (const finding of run?.findings ?? []) {
    process.stderr.write(`::error::${formatFinding(finding)}\n`);
  }
  for (const unread of run?.incomplete ?? []) {
    process.stderr.write(`::error::incomplete read, not a finding: ${formatFinding(unread)}\n`);
  }
  log(`Status: ${status}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  return status === "clean" ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv[2]));
