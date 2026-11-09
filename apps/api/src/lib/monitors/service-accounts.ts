import { StrKey } from "@stellar/stellar-sdk";
import { xlmToStroops, stroopsToXlm } from "@/lib/utils/amounts";

/**
 * The service-account monitors of docs/monitoring-plan.md section 4: the account as transaction
 * source (S4a.Information.1.M.1, S4b.Information.1.M.1), the balance floor (S4a.Elevation.1.M.1,
 * S4b.Denial.1.M.1) and the forward that pays out more than the merge delivered
 * (S4a.Elevation.1.M.1). Pure over Horizon's JSON and the repository files so the workflow can
 * run them against any network and the unit tests can feed them fixtures.
 */

export type ServiceRole = "mediator" | "sponsor";
export type ServiceNetwork = "mainnet" | "testnet";

export interface ServiceAccount {
  role: ServiceRole;
  network: ServiceNetwork;
  address: string;
  /** Alert when the native balance drops below this many XLM. */
  floorXlm: string;
  /** A rotated-out address, still watched for use of its key after it was drained. */
  retired?: true;
}

export interface HorizonAccount {
  balances: Array<{ asset_type: string; balance: string }>;
}

export interface HorizonTransaction {
  hash: string;
  created_at: string;
  source_account: string;
  paging_token: string;
}

export interface HorizonTransactionPage {
  _embedded: { records: HorizonTransaction[] };
}

export interface HorizonEffect {
  type: string;
  account?: string;
  amount?: string;
}

/** A condition that fired, in the form the workflow prints and the alert carries. */
export interface Finding {
  account: ServiceAccount;
  message: string;
}

const ROLES: readonly ServiceRole[] = ["mediator", "sponsor"];
const NETWORKS: readonly ServiceNetwork[] = ["testnet", "mainnet"];

/**
 * The mediator floor is its base reserve; the sponsor floor is a provisional top-up level until
 * real usage sets one.
 */
const FLOOR_XLM: Record<ServiceRole, string> = { mediator: "1", sponsor: "50" };

/** The row labels of the inventory table in docs/monitoring-plan.md section 1. */
const PLAN_LABEL: Record<ServiceRole, string> = {
  mediator: "Mediator account",
  sponsor: "Fee-bump sponsor",
};

const NOT_DEPLOYED = "not yet deployed";

export const PLAN_PATH = "docs/monitoring-plan.md";

/** The repository variable that holds one service account's address. */
export function addressVariable(role: ServiceRole, network: ServiceNetwork): string {
  const prefix = role === "mediator" ? "MEDIATOR" : "FEE_ACCOUNT";
  return `${prefix}_ADDRESS_${network.toUpperCase()}`;
}

/** The optional variable that keeps a rotated-out address watched after a key rotation. */
export function retiredVariable(role: ServiceRole, network: ServiceNetwork): string {
  return `${addressVariable(role, network)}_RETIRED`;
}

/** Each service account's address as the plan lists it, or null where it says not yet deployed. */
export type PlannedAccounts = Record<ServiceNetwork, Record<ServiceRole, string | null>>;

export function plannedAccounts(markdown: string): PlannedAccounts {
  const lines = markdown.split("\n");
  const cell = (role: ServiceRole, network: ServiceNetwork): string | null => {
    const label = `${PLAN_LABEL[role]} (${network})`;
    const row = lines.find((line) => line.split("|")[1]?.trim() === label);
    if (!row) throw new Error(`${PLAN_PATH} has no "${label}" row in its inventory table`);
    const value = row.split("|")[2]?.trim() ?? "";
    if (value === NOT_DEPLOYED) return null;
    const address = value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : "";
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new Error(
        `${PLAN_PATH} "${label}" must hold an account id in backticks or "${NOT_DEPLOYED}"`
      );
    }
    return address;
  };
  return {
    testnet: { mediator: cell("mediator", "testnet"), sponsor: cell("sponsor", "testnet") },
    mainnet: { mediator: cell("mediator", "mainnet"), sponsor: cell("sponsor", "mainnet") },
  };
}

/**
 * Builds the account list from the repository variables, one per role and network, and fails
 * with every problem at once when the variables, the plan's inventory and the mainnet
 * stellar.toml (already parsed) disagree. A variable the plan expects that is unset is a problem,
 * never a network silently left out.
 */
export function loadServiceAccounts(
  env: Record<string, string | undefined>,
  plan: PlannedAccounts,
  stellarToml: unknown
): ServiceAccount[] {
  const problems: string[] = [];
  const accounts: ServiceAccount[] = [];

  for (const network of NETWORKS) {
    for (const role of ROLES) {
      const name = addressVariable(role, network);
      const value = env[name] ?? "";
      const planned = plan[network][role];
      if (value === "") {
        if (planned !== null) {
          problems.push(
            `${name} is not set, but ${PLAN_PATH} lists the ${role} (${network}) account. ` +
              "Set it as a repository variable."
          );
        }
        continue;
      }
      if (!StrKey.isValidEd25519PublicKey(value)) {
        problems.push(`${name} is not a Stellar account id`);
        continue;
      }
      if (value !== planned) {
        problems.push(
          `${name} is ${value}, but ${PLAN_PATH} lists the ${role} (${network}) account as ` +
            `${planned ?? NOT_DEPLOYED}. A rotation updates both.`
        );
      }
      accounts.push({ role, network, address: value, floorXlm: FLOOR_XLM[role] });
    }
  }

  const listed = (stellarToml as { ACCOUNTS?: unknown } | null)?.ACCOUNTS ?? [];
  if (!Array.isArray(listed) || !listed.every((a) => typeof a === "string")) {
    problems.push("stellar.toml ACCOUNTS must be a list of account ids (SEP-1)");
  } else {
    const mainnet = accounts.filter((a) => a.network === "mainnet");
    for (const address of listed) {
      if (!mainnet.some((a) => a.address === address)) {
        problems.push(`stellar.toml lists ${address}, which is not a configured mainnet account`);
      }
    }
    const mediator = mainnet.find((a) => a.role === "mediator");
    if (mediator && !listed.includes(mediator.address)) {
      problems.push(`stellar.toml ACCOUNTS does not list the mainnet mediator ${mediator.address}`);
    }
  }

  // A retired account is merged out, so it is in neither the plan nor stellar.toml and has no
  // balance to floor; what is left to watch is its key sourcing a transaction or a forward.
  for (const network of NETWORKS) {
    for (const role of ROLES) {
      const name = retiredVariable(role, network);
      const value = env[name] ?? "";
      if (value === "") continue;
      if (!StrKey.isValidEd25519PublicKey(value)) {
        problems.push(`${name} is not a Stellar account id`);
        continue;
      }
      if (value === env[addressVariable(role, network)]) {
        problems.push(
          `${name} is the current ${role} (${network}) account. It holds the address rotated out.`
        );
        continue;
      }
      accounts.push({ role, network, address: value, floorXlm: FLOOR_XLM[role], retired: true });
    }
  }

  if (problems.length === 0 && accounts.length === 0) {
    problems.push(
      `No service account is configured: set ${NETWORKS.flatMap((n) =>
        ROLES.map((r) => addressVariable(r, n))
      ).join(", ")} as repository variables.`
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return accounts;
}

export const DEFAULT_HISTORY_HOURS = 168;
const MIN_HISTORY_HOURS = 2;
const MAX_HISTORY_HOURS = 720;

/** MONITOR_HISTORY_HOURS: how far back the history checks read. Unset means the default. */
export function historyWindowHours(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_HISTORY_HOURS;
  const hours = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(hours >= MIN_HISTORY_HOURS && hours <= MAX_HISTORY_HOURS)) {
    throw new Error(
      `MONITOR_HISTORY_HOURS must be a whole number of hours from ${MIN_HISTORY_HOURS} to ${MAX_HISTORY_HOURS}`
    );
  }
  return hours;
}

export const HORIZON_PAGE_LIMIT = 200;
export const MAX_HISTORY_PAGES = 25;

export interface TransactionHistory {
  transactions: HorizonTransaction[];
  /** False when the page cap was reached before the window start: the rest went unread. */
  complete: boolean;
}

/**
 * Every transaction touching `address` created at or after `since`, newest first, paging
 * through Horizon with the last record's paging token as the cursor.
 */
export async function transactionsInWindow(
  get: (path: string) => Promise<HorizonTransactionPage>,
  address: string,
  since: Date,
  maxPages = MAX_HISTORY_PAGES
): Promise<TransactionHistory> {
  const transactions: HorizonTransaction[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: String(HORIZON_PAGE_LIMIT), order: "desc" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const records = (await get(`/accounts/${address}/transactions?${query}`))._embedded.records;
    for (const tx of records) {
      if (Date.parse(tx.created_at) < since.getTime()) return { transactions, complete: true };
      transactions.push(tx);
    }
    if (records.length < HORIZON_PAGE_LIMIT) return { transactions, complete: true };
    cursor = records[records.length - 1].paging_token;
  }
  return { transactions, complete: false };
}

/** The finding for a history the page cap cut short: the check did not see the whole window. */
export function incompleteHistoryFinding(account: ServiceAccount, hours: number): Finding {
  return {
    account,
    message:
      `more than ${MAX_HISTORY_PAGES * HORIZON_PAGE_LIMIT} transactions in the last ${hours} h; ` +
      "the older ones were not checked. Lower MONITOR_HISTORY_HOURS.",
  };
}

/**
 * S4a.Information.1.M.1 and S4b.Information.1.M.1. The sponsor pays fees, so it appears as
 * fee_account and the user's account is always the source. The mediator co-signs a forward it
 * never originates. Either one sourcing a transaction means the key signed something this
 * codebase did not build. Baseline measured 2026-09-18: 0 for both.
 */
export function sourcedFinding(account: ServiceAccount, tx: HorizonTransaction): Finding | null {
  if (tx.source_account !== account.address) return null;
  return {
    account,
    message: `transaction ${tx.hash} (${tx.created_at}) is sourced from the account. Expected none.`,
  };
}

export function nativeBalanceStroops(account: HorizonAccount): bigint | null {
  const native = account.balances.find((b) => b.asset_type === "native");
  return native ? BigInt(xlmToStroops(native.balance)) : null;
}

/** S4a.Elevation.1.M.1 and the balance half of S4b.Denial.1.M.1. */
export function balanceFinding(account: ServiceAccount, horizon: HorizonAccount): Finding | null {
  const balance = nativeBalanceStroops(horizon);
  if (balance === null) {
    return { account, message: "Horizon returned no native balance for the account" };
  }
  const floor = BigInt(xlmToStroops(account.floorXlm));
  if (balance >= floor) return null;
  return {
    account,
    message: `native balance ${stroopsToXlm(balance)} XLM is below the ${account.floorXlm} XLM floor`,
  };
}

/**
 * S4a.Elevation.1.M.1's other signal: in one transaction the mediator paid out more than the merge
 * delivered to it, so the difference came from its own balance. Horizon's effects carry what the
 * merge credited and what the forward debited; the API bounds the forward by the merge at co-sign
 * time, so any transaction where the debit exceeds the credit is one that got past that bound.
 */
export function forwardFinding(
  account: ServiceAccount,
  tx: HorizonTransaction,
  effects: HorizonEffect[]
): Finding | null {
  let credited = 0n;
  let debited = 0n;
  for (const effect of effects) {
    if (effect.account !== account.address || effect.amount === undefined) continue;
    if (effect.type === "account_credited") credited += BigInt(xlmToStroops(effect.amount));
    if (effect.type === "account_debited") debited += BigInt(xlmToStroops(effect.amount));
  }
  if (debited <= credited) return null;
  return {
    account,
    message:
      `transaction ${tx.hash} (${tx.created_at}) paid out ${stroopsToXlm(debited)} XLM ` +
      `but the merge delivered ${stroopsToXlm(credited)} XLM`,
  };
}

export type ServiceCheck = "keys" | "balances" | "forward";

/** The accounts one check reads: a retired account has no balance left to floor. */
export function accountsFor(accounts: ServiceAccount[], check: ServiceCheck): ServiceAccount[] {
  switch (check) {
    case "keys":
      return accounts;
    case "balances":
      return accounts.filter((a) => !a.retired);
    case "forward":
      return accounts.filter((a) => a.role === "mediator");
  }
}

export function roleLabel(a: ServiceAccount): string {
  return a.retired ? `${a.role} (retired)` : a.role;
}

export function formatFinding(f: Finding): string {
  return `${roleLabel(f.account)} (${f.account.network}, ${f.account.address}): ${f.message}`;
}
