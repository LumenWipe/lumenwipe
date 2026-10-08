import { StrKey } from "@stellar/stellar-sdk";
import { xlmToStroops, stroopsToXlm } from "@/lib/utils/amounts";

/**
 * The two service-account monitors of docs/monitoring-plan.md section 4 that need more than one
 * Horizon query: the balance floor (S4a.Elevation.1.M.1, S4b.Denial.1.M.1) and the forward that
 * pays out more than the merge delivered (S4a.Elevation.1.M.1). Pure over Horizon's JSON so the
 * workflow can run them against any network and the unit tests can feed them fixtures.
 */

export type ServiceRole = "mediator" | "sponsor";
export type ServiceNetwork = "mainnet" | "testnet";

export interface ServiceAccount {
  role: ServiceRole;
  network: ServiceNetwork;
  address: string;
  /** Alert when the native balance drops below this many XLM. */
  floorXlm: string;
}

export interface HorizonAccount {
  balances: Array<{ asset_type: string; balance: string }>;
}

export interface HorizonTransaction {
  hash: string;
  created_at: string;
  source_account: string;
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

const ROLES: readonly string[] = ["mediator", "sponsor"];
const NETWORKS: readonly string[] = ["mainnet", "testnet"];

/** The workflow hands the accounts in as a JSON array; an entry that is not exactly right fails the run. */
export function parseServiceAccounts(json: string): ServiceAccount[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("SERVICE_ACCOUNTS is not valid JSON");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("SERVICE_ACCOUNTS must be a non-empty JSON array");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`SERVICE_ACCOUNTS[${i}] is not an object`);
    }
    const { role, network, address, floorXlm } = entry as Record<string, unknown>;
    if (typeof role !== "string" || !ROLES.includes(role)) {
      throw new Error(`SERVICE_ACCOUNTS[${i}].role must be one of ${ROLES.join(", ")}`);
    }
    if (typeof network !== "string" || !NETWORKS.includes(network)) {
      throw new Error(`SERVICE_ACCOUNTS[${i}].network must be one of ${NETWORKS.join(", ")}`);
    }
    if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
      throw new Error(`SERVICE_ACCOUNTS[${i}].address is not a Stellar account id`);
    }
    if (typeof floorXlm !== "string" || !/^\d+(\.\d{1,7})?$/.test(floorXlm)) {
      throw new Error(`SERVICE_ACCOUNTS[${i}].floorXlm must be an XLM amount string`);
    }
    return {
      role: role as ServiceRole,
      network: network as ServiceNetwork,
      address,
      floorXlm,
    };
  });
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

export function formatFinding(f: Finding): string {
  return `${f.account.role} (${f.account.network}, ${f.account.address}): ${f.message}`;
}
