import { StrKey } from "@stellar/stellar-sdk";
import { xlmToStroops, stroopsToXlm } from "@/lib/utils/amounts";

/**
 * The service-account monitors of docs/monitoring-plan.md section 4: the account as transaction
 * source (S4a.Information.1.M.1, S4b.Information.1.M.1), the balance floor (S4a.Elevation.1.M.1,
 * S4b.Denial.1.M.1) and the forward that pays out more than the merge delivered, or any debit of the
 * sponsor (S4a.Elevation.1.M.1). Pure over Horizon's JSON and the repository files so the workflow can
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
  /** The rotation operator a retired address is drained into: the one merge that is no payout. */
  drainTo?: string;
}

export interface HorizonAccount {
  balances: Array<{ asset_type: string; balance: string }>;
  /** Unix seconds of the last change to the sequence number; absent or null when it never moved. */
  sequence_time?: string | null;
}

export interface HorizonTransaction {
  hash: string;
  created_at: string;
  source_account: string;
  /** Who paid the fee: the outer fee account of a fee bump, the source otherwise. */
  fee_account?: string;
  paging_token: string;
}

export interface HorizonTransactionPage {
  _embedded: { records: HorizonTransaction[] };
}

/** One operation from an account's operations, with `join=transactions` embedding its transaction. */
export interface HorizonOperation {
  type: string;
  /** The operation's source: its own when set, the transaction's otherwise. */
  source_account: string;
  transaction_hash: string;
  created_at: string;
  paging_token: string;
  /** account_merge: the destination. */
  into?: string;
  /** payment: the asset paid. */
  asset_type?: string;
  /** invoke_host_function: the asset contract moves it made, each with the address debited. */
  asset_balance_changes?: AssetBalanceChange[] | null;
  transaction?: { source_account: string };
}

export interface AssetBalanceChange {
  type: string;
  asset_type: string;
  asset_code?: string;
  from?: string;
  to?: string;
  amount: string;
}

export interface HorizonOperationPage {
  _embedded: { records: HorizonOperation[] };
}

export interface HorizonEffect {
  type: string;
  account?: string;
  amount?: string;
  /** `<operation id>-<index>`: the operation that produced the effect. */
  paging_token?: string;
  asset_type?: string;
  asset_code?: string;
}

/** One record of an account's own effects list, which always carries its time and position. */
export interface HorizonAccountEffect extends HorizonEffect {
  created_at: string;
  paging_token: string;
}

export interface HorizonAccountEffectPage {
  _embedded: { records: HorizonAccountEffect[] };
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
const PLAN_LABEL: Record<PlannedRole, string> = {
  mediator: "Mediator account",
  sponsor: "Fee-bump sponsor",
  operator: "Rotation operator",
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

/** The variable that holds the account a rotation drains a retired address into. */
export function operatorVariable(network: ServiceNetwork): string {
  return `OPERATOR_ADDRESS_${network.toUpperCase()}`;
}

/** The service accounts and the rotation operator, each a row of the plan's inventory. */
export type PlannedRole = ServiceRole | "operator";

/** Each address as the plan lists it, or null where it says not yet deployed. */
export type PlannedAccounts = Record<ServiceNetwork, Record<PlannedRole, string | null>>;

export function plannedAccounts(markdown: string): PlannedAccounts {
  const lines = markdown.split("\n");
  const cell = (role: PlannedRole, network: ServiceNetwork): string | null => {
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
  const network = (n: ServiceNetwork) => ({
    mediator: cell("mediator", n),
    sponsor: cell("sponsor", n),
    operator: cell("operator", n),
  });
  return { testnet: network("testnet"), mainnet: network("mainnet") };
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

  /** The variable's account id, held to the plan's row; null when unset or not an account id. */
  const agreed = (name: string, what: string, planned: string | null): string | null => {
    const value = env[name] ?? "";
    if (value === "") {
      if (planned !== null) {
        problems.push(
          `${name} is not set, but ${PLAN_PATH} lists the ${what} account. ` +
            "Set it as a repository variable."
        );
      }
      return null;
    }
    if (!StrKey.isValidEd25519PublicKey(value)) {
      problems.push(`${name} is not a Stellar account id`);
      return null;
    }
    if (value !== planned) {
      problems.push(
        `${name} is ${value}, but ${PLAN_PATH} lists the ${what} account as ` +
          `${planned ?? NOT_DEPLOYED}. A rotation updates both.`
      );
    }
    return value;
  };

  for (const network of NETWORKS) {
    for (const role of ROLES) {
      const name = addressVariable(role, network);
      const value = agreed(name, `${role} (${network})`, plan[network][role]);
      if (value !== null) {
        accounts.push({ role, network, address: value, floorXlm: FLOOR_XLM[role] });
      }
    }
  }

  const operators: Record<ServiceNetwork, string | null> = {
    testnet: agreed(
      operatorVariable("testnet"),
      "rotation operator (testnet)",
      plan.testnet.operator
    ),
    mainnet: agreed(
      operatorVariable("mainnet"),
      "rotation operator (mainnet)",
      plan.mainnet.operator
    ),
  };

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
      const drainTo = operators[network];
      if (drainTo === null) {
        problems.push(
          `${name} is set, but ${operatorVariable(network)} is not: the forward check could not ` +
            "tell the rotation's drain from a payout. Set it, and its row in " +
            `${PLAN_PATH}, to the account the rotation drains into.`
        );
        continue;
      }
      accounts.push({
        role,
        network,
        address: value,
        floorXlm: FLOOR_XLM[role],
        retired: true,
        drainTo,
      });
    }
  }

  // A drain into a service account would read as that account's own credit, and the runbooks
  // drain into an account that is neither relay nor sponsor.
  for (const network of NETWORKS) {
    const operator = operators[network];
    const clash = accounts.find((a) => a.network === network && a.address === operator);
    if (clash) {
      problems.push(
        `${operatorVariable(network)} is the ${roleLabel(clash)} (${network}) account. ` +
          "The rotation operator must be neither relay nor sponsor."
      );
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

export interface History<T> {
  records: T[];
  /** False when the read stopped before the window start: the rest went unread. */
  complete: boolean;
  /** Why the read stopped, when it is not complete. */
  stopped?: string;
}

export interface TransactionHistory {
  transactions: HorizonTransaction[];
  /** False when the read stopped before the window start: the rest went unread. */
  complete: boolean;
  /** Why the read stopped, when it is not complete. */
  stopped?: string;
}

/**
 * Every record of one of an account's Horizon lists created at or after `since`, newest first,
 * paging with the last record's paging token as the cursor. A request that fails ends the read
 * with what came before it, so the records already read are still judged.
 */
async function recordsInWindow<T extends { created_at: string; paging_token: string }>(
  get: (path: string) => Promise<{ _embedded: { records: T[] } }>,
  path: string,
  params: Record<string, string>,
  since: Date,
  maxPages: number
): Promise<History<T>> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      ...params,
      limit: String(HORIZON_PAGE_LIMIT),
      order: "desc",
    });
    if (cursor !== undefined) query.set("cursor", cursor);
    let records: T[];
    try {
      records = (await get(`${path}?${query}`))._embedded.records;
    } catch (error) {
      return { records: found, complete: false, stopped: (error as Error).message };
    }
    for (const record of records) {
      if (Date.parse(record.created_at) < since.getTime())
        return { records: found, complete: true };
      found.push(record);
    }
    if (records.length < HORIZON_PAGE_LIMIT) return { records: found, complete: true };
    cursor = records[records.length - 1].paging_token;
  }
  return {
    records: found,
    complete: false,
    stopped: `the ${maxPages}-page cap was reached; lower MONITOR_HISTORY_HOURS`,
  };
}

/**
 * Every transaction touching `address` created at or after `since`, newest first. Failed ones only
 * when `includeFailed`: a failed fee bump still charged its fee account, which signed it.
 */
export async function transactionsInWindow(
  get: (path: string) => Promise<HorizonTransactionPage>,
  address: string,
  since: Date,
  maxPages = MAX_HISTORY_PAGES,
  includeFailed = false
): Promise<TransactionHistory> {
  const { records, ...read } = await recordsInWindow(
    get,
    `/accounts/${address}/transactions`,
    includeFailed ? { include_failed: "true" } : {},
    since,
    maxPages
  );
  return { transactions: records, ...read };
}

/**
 * Every operation `address` takes part in created at or after `since`, newest first, each with
 * its transaction's source, failed transactions included: a failed transaction still carries a
 * valid signature of every key it needed.
 */
export async function operationsInWindow(
  get: (path: string) => Promise<HorizonOperationPage>,
  address: string,
  since: Date,
  maxPages = MAX_HISTORY_PAGES
): Promise<History<HorizonOperation>> {
  return recordsInWindow(
    get,
    `/accounts/${address}/operations`,
    { join: "transactions", include_failed: "true" },
    since,
    maxPages
  );
}

/** Every effect on `address` itself created at or after `since`, newest first. */
export async function effectsInWindow(
  get: (path: string) => Promise<HorizonAccountEffectPage>,
  address: string,
  since: Date,
  maxPages = MAX_HISTORY_PAGES
): Promise<History<HorizonAccountEffect>> {
  return recordsInWindow(get, `/accounts/${address}/effects`, {}, since, maxPages);
}

/**
 * What a check reports for a list it could not read to the window start, after a page cap, a
 * Horizon error or timeout, or the check's time budget. Nothing in the unread part was seen, so
 * it is not a finding, and it is never clean.
 */
export function incompleteRead(
  account: ServiceAccount,
  hours: number,
  list: string,
  read: { count: number; stopped?: string }
): Finding {
  const what = read.count === 0 ? `none of the ${list}` : `only the newest ${read.count} ${list}`;
  return {
    account,
    message:
      `${what} of the last ${hours} h were read before the read stopped: ` +
      `${read.stopped ?? "unknown reason"}. The rest were not checked.`,
  };
}

/**
 * How a check ended: a finding when anything fired, which pages whatever else went unread; an
 * incomplete read when nothing fired but something could not be read; clean only otherwise.
 */
export type CheckStatus = "clean" | "finding" | "incomplete";

export function checkStatus(findings: Finding[], incomplete: Finding[]): CheckStatus {
  if (findings.length > 0) return "finding";
  return incomplete.length > 0 ? "incomplete" : "clean";
}

/**
 * The records of a history that belong to transactions read in full. Horizon lists a
 * transaction's records newest operation first, so a read that stopped early may hold the
 * forward's payment without the merge before it; the oldest transaction of an incomplete read is
 * left out, as part of what went unread, rather than judged by half.
 */
export function wholeTransactions<T>(
  history: History<T>,
  transactionOf: (record: T) => string
): T[] {
  const last = history.records.at(-1);
  if (history.complete || last === undefined) return history.records;
  const cut = transactionOf(last);
  return history.records.filter((record) => transactionOf(record) !== cut);
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

/**
 * The relay paying a fee: it never does, so a transaction with the relay as `fee_account` that it
 * did not source (that one is reported as sourced) is its key signing a fee bump. The sponsor pays
 * every sponsored close's fee, and a retired sponsor the ones from before the switch, which the
 * history window still holds, so neither is judged here.
 */
export function feeAccountFinding(account: ServiceAccount, tx: HorizonTransaction): Finding | null {
  if (account.role !== "mediator") return null;
  if (tx.fee_account !== account.address || tx.source_account === account.address) return null;
  return {
    account,
    message:
      `transaction ${tx.hash} (${tx.created_at}) is a fee bump the account paid for, ` +
      `sourced by ${tx.source_account}. Expected none: the relay never pays a fee.`,
  };
}

function assetLabel(asset: { asset_type?: string; asset_code?: string }): string {
  return asset.asset_type === "native" ? "XLM" : (asset.asset_code ?? asset.asset_type ?? "asset");
}

/**
 * S4a.Information.1.M.1 and S4b.Information.1.M.1 for Soroban authorization: a contract call that
 * moved an asset out of the account. The call and its transaction are sourced by someone else, but
 * an asset contract debits a G account only on that account's own authorization (a `transfer`, or
 * a `transfer_from` after an `approve`), and the API never builds one. A move into the account is
 * not judged, so nobody can raise this by sending to it.
 */
export function contractDebitFinding(
  account: ServiceAccount,
  transaction: HorizonOperation[]
): Finding | null {
  const moves = transaction.flatMap((op) =>
    (op.asset_balance_changes ?? [])
      .filter((change) => change.from === account.address)
      .map((change) => ({ op, change }))
  );
  if (moves.length === 0) return null;
  const { transaction_hash: hash, created_at: createdAt, source_account: caller } = moves[0].op;
  const moved = moves.map(({ change }) => `${change.amount} ${assetLabel(change)}`).join(", ");
  return {
    account,
    message:
      `transaction ${hash} (${createdAt}) moved ${moved} out of the account through a contract ` +
      `call sourced by ${caller}, authorized by its key. Expected none.`,
  };
}

/**
 * The operations the account may source in a transaction it did not: the mediator's forward, a
 * native payment in a transaction that also merges an account into the mediator (the forward
 * check bounds its amount), and a retired account's drain.
 */
function isExpectedOperation(
  account: ServiceAccount,
  operation: HorizonOperation,
  transaction: HorizonOperation[]
): boolean {
  const txSource = operation.transaction?.source_account;
  if (operation.type === "account_merge") {
    return isRotationDrain(account, txSource, operation.into);
  }
  return (
    account.role === "mediator" &&
    operation.type === "payment" &&
    operation.asset_type === "native" &&
    txSource !== undefined &&
    txSource !== account.address &&
    transaction.some((op) => op.type === "account_merge" && op.into === account.address)
  );
}

/**
 * S4a.Information.1.M.1 and S4b.Information.1.M.1 for operation sources: a transaction someone
 * else sourced in which the account sourced an operation the API never builds, such as a
 * `set_options` adding a signer or a `change_trust` that blocks the drain. `transaction` is every
 * operation of one transaction that the account's operations list returned.
 */
export function operationSourceFinding(
  account: ServiceAccount,
  transaction: HorizonOperation[]
): Finding | null {
  const unexpected = transaction.filter(
    (op) => op.source_account === account.address && !isExpectedOperation(account, op, transaction)
  );
  if (unexpected.length === 0) return null;
  const { transaction_hash: hash, created_at: createdAt } = unexpected[0];
  return {
    account,
    message:
      `transaction ${hash} (${createdAt}) has operations sourced from the account: ` +
      `${unexpected.map((op) => op.type).join(", ")}. Expected none but the forward and the drain.`,
  };
}

/**
 * S4a.Information.1.M.1 and S4b.Information.1.M.1 from the account record. The sequence number
 * moves only when the account sources a transaction, failed or not, or bumps its own sequence, and
 * neither the relay's forward nor a fee bump the sponsor pays moves it. One request that no flood
 * of history can push out of reach.
 */
export function sequenceFinding(
  account: ServiceAccount,
  record: HorizonAccount,
  since: Date
): Finding | null {
  const seconds = Number(record.sequence_time ?? 0);
  if (!(seconds * 1000 >= since.getTime())) return null;
  return {
    account,
    message:
      `its sequence number moved at ${new Date(seconds * 1000).toISOString()}: its key sourced ` +
      "a transaction or bumped its sequence. Expected never.",
  };
}

/**
 * The keys check for one account: each transaction it sourced or, as the relay, paid the fee for,
 * and each other transaction in which it sourced an unexpected operation or a contract call
 * debited it, reported once. The sequence finding is reported when nothing else is, so a use of
 * the key that the history read missed still fires.
 */
export function keysFindings(
  account: ServiceAccount,
  transactions: HorizonTransaction[],
  operations: HorizonOperation[],
  sequence: Finding | null = null
): Finding[] {
  const findings = new Map<string, Finding>();
  for (const tx of transactions) {
    const finding = sourcedFinding(account, tx) ?? feeAccountFinding(account, tx);
    if (finding) findings.set(tx.hash, finding);
  }
  const byTransaction = new Map<string, HorizonOperation[]>();
  for (const op of operations) {
    byTransaction.set(op.transaction_hash, [...(byTransaction.get(op.transaction_hash) ?? []), op]);
  }
  for (const [hash, transaction] of byTransaction) {
    if (findings.has(hash)) continue;
    const finding =
      operationSourceFinding(account, transaction) ?? contractDebitFinding(account, transaction);
    if (finding) findings.set(hash, finding);
  }
  if (findings.size === 0 && sequence !== null) return [sequence];
  return [...findings.values()];
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

/** The operation an effect belongs to, from its `<operation id>-<index>` paging token. */
function operationOf(effect: HorizonEffect): string | undefined {
  const parts = effect.paging_token?.split("-");
  return parts?.length === 2 ? parts[0] : undefined;
}

/**
 * The rotation's own drain of a retired account: a merge of the account into the operator it was
 * configured with, in a transaction the operator sourced. Holding the old key alone cannot
 * produce it: the transaction source needs the operator's signature, and the balance lands with
 * the operator.
 */
function isRotationDrain(
  account: ServiceAccount,
  txSource: string | undefined,
  mergedInto: string | undefined
): boolean {
  const drainTo = account.drainTo;
  return (
    account.retired === true &&
    drainTo !== undefined &&
    txSource === drainTo &&
    mergedInto === drainTo
  );
}

/**
 * The transaction an effect belongs to. Horizon's operation ids are TOIDs, whose low 12 bits
 * number the operation inside its transaction; an effect with no operation id stands alone.
 */
export function transactionOf(effect: HorizonAccountEffect): string {
  const operation = operationOf(effect);
  if (operation === undefined || !/^\d+$/.test(operation)) return effect.paging_token;
  return String((BigInt(operation) >> 12n) << 12n);
}

/**
 * The operations whose record the forward check reads to tell a retired account's drain from a
 * payout: each one that removed the account, which only a merge does. None for an account with
 * no drain to tell apart.
 */
export function removalOperations(
  account: ServiceAccount,
  effects: HorizonAccountEffect[]
): string[] {
  if (account.retired !== true || account.drainTo === undefined) return [];
  const removals = new Set<string>();
  for (const effect of effects) {
    if (effect.type !== "account_removed" || effect.account !== account.address) continue;
    const operation = operationOf(effect);
    if (operation !== undefined && /^\d+$/.test(operation)) removals.add(operation);
  }
  return [...removals];
}

/**
 * S4a.Elevation.1.M.1's other signal: in one transaction the mediator paid out more than the merge
 * delivered to it, so the difference came from its own balance. The account's own effects carry
 * what the merge credited and what the forward debited, grouped here by transaction; the API
 * bounds the forward by the merge at co-sign time, so any transaction where the debit exceeds the
 * credit is one that got past that bound. A retired account's drain counts what it delivered to
 * the operator as delivered, in that operation only, so any other debit in the same transaction
 * still fires. `removals` holds the operation record of each of `removalOperations`; a
 * transaction with a removal whose record is missing is not judged, and the caller reports it
 * unread. A retired sponsor is read the same way: its fee bumps are fees, not effects, so only a
 * payout or a merge debits it.
 */
export function forwardFindings(
  account: ServiceAccount,
  effects: HorizonAccountEffect[],
  removals: HorizonOperation[]
): Finding[] {
  const drains = new Set(
    removals
      .filter(
        (op) =>
          op.type === "account_merge" &&
          isRotationDrain(account, op.transaction?.source_account, op.into)
      )
      .map((op) => op.paging_token)
  );
  const resolved = new Set(removals.map((op) => op.paging_token));
  const unresolved = new Set(
    removalOperations(account, effects).filter((operation) => !resolved.has(operation))
  );
  const transactions = new Map<string, HorizonAccountEffect[]>();
  for (const effect of effects) {
    if (effect.account !== account.address) continue;
    const key = transactionOf(effect);
    transactions.set(key, [...(transactions.get(key) ?? []), effect]);
  }
  const findings: Finding[] = [];
  for (const transaction of transactions.values()) {
    const operations = [...new Set(transaction.map((e) => operationOf(e) ?? e.paging_token))];
    if (operations.some((operation) => unresolved.has(operation))) continue;
    let credited = 0n;
    let debited = 0n;
    for (const effect of transaction) {
      if (typeof effect.amount !== "string") continue;
      const amount = BigInt(xlmToStroops(effect.amount));
      if (effect.type === "account_credited") credited += amount;
      if (effect.type !== "account_debited") continue;
      debited += amount;
      const operation = operationOf(effect);
      if (operation !== undefined && drains.has(operation)) credited += amount;
    }
    if (debited <= credited) continue;
    findings.push({
      account,
      message:
        `operations ${operations.join(", ")} (${transaction[0].created_at}) paid out ` +
        `${stroopsToXlm(debited)} XLM but the merge delivered ${stroopsToXlm(credited)} XLM`,
    });
  }
  return findings;
}

/**
 * The current sponsor has no forward and no drain: it pays fees, which are not effects, so any
 * debit of it is a payout. The relay and a retired account are judged per transaction instead.
 */
export function anyDebitIsPayout(account: ServiceAccount): boolean {
  return account.role === "sponsor" && account.retired !== true;
}

/**
 * S4a.Elevation.1.M.1 for the current sponsor: any debit of it, by any operation, is a payout of
 * its float. One finding per operation, named by the operation id Horizon resolves to its
 * transaction.
 */
export function sponsorDebitFindings(
  account: ServiceAccount,
  effects: HorizonAccountEffect[]
): Finding[] {
  const debits = new Map<string, HorizonAccountEffect[]>();
  for (const effect of effects) {
    if (effect.type !== "account_debited" || effect.account !== account.address) continue;
    const operation = operationOf(effect) ?? effect.paging_token;
    debits.set(operation, [...(debits.get(operation) ?? []), effect]);
  }
  return [...debits].map(([operation, debited]) => ({
    account,
    message:
      `operation ${operation} (${debited[0].created_at}) debited ` +
      `${debited.map((e) => `${e.amount ?? "?"} ${assetLabel(e)}`).join(", ")} from the account. ` +
      "Expected none: the sponsor only pays fees, and a fee is not an effect.",
  }));
}

export type ServiceCheck = "keys" | "balances" | "forward";

/**
 * The accounts one check reads. A retired account has no balance left to floor. The forward check
 * reads every account's own effects: the relay and a retired account against the merge and the
 * drain, the current sponsor for any debit at all.
 */
export function accountsFor(accounts: ServiceAccount[], check: ServiceCheck): ServiceAccount[] {
  switch (check) {
    case "keys":
      return accounts;
    case "balances":
      return accounts.filter((a) => !a.retired);
    case "forward":
      return accounts;
  }
}

export function roleLabel(a: ServiceAccount): string {
  return a.retired ? `${a.role} (retired)` : a.role;
}

export function formatFinding(f: Finding): string {
  return `${roleLabel(f.account)} (${f.account.network}, ${f.account.address}): ${f.message}`;
}
