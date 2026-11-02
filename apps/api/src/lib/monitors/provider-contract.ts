/**
 * The contract the API relies on from a Horizon-compatible provider, checked read-only: every
 * route, field and header below is one the close flow reads. See docs/monitoring-plan.md.
 *
 * Nothing that comes back from a provider is echoed, and a provider is named by its network and
 * list position only: this output lands in public logs, issues and alerts, and a hostname can
 * name a vendor or carry a key.
 */

import { randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { createDeadline } from "@/common/deadline";
import { WELL_KNOWN_ISSUERS, type Network, type ProviderEndpoint } from "@/config/networks";
import { UpstreamError, upstreamGetJson } from "@/lib/stellar/upstream-client";

const REQUEST_BUDGET_MS = 30_000;

type FieldType = "string" | "number" | "boolean" | "object" | "array";
type Shape = Record<string, FieldType>;

const ACCOUNT: Shape = {
  sequence: "string",
  subentry_count: "number",
  thresholds: "object",
  "thresholds.low_threshold": "number",
  "thresholds.med_threshold": "number",
  "thresholds.high_threshold": "number",
  flags: "object",
  "flags.auth_immutable": "boolean",
  signers: "array",
  balances: "array",
  data: "object",
  num_sponsoring: "number",
  num_sponsored: "number",
};
const OFFER: Shape = {
  id: "string",
  seller: "string",
  selling: "object",
  buying: "object",
  amount: "string",
  price: "string",
};
const OPERATION: Shape = { type: "string", source_account: "string" };
const CLAIMABLE_BALANCE: Shape = {
  id: "string",
  asset: "string",
  amount: "string",
  claimants: "array",
};
const PATH: Shape = { destination_amount: "string", path: "array" };
const ASSET_STATS: Shape = {
  num_claimable_balances: "number",
  num_liquidity_pools: "number",
  num_contracts: "number",
  accounts: "object",
  balances: "object",
  claimable_balances_amount: "string",
  liquidity_pools_amount: "string",
  contracts_amount: "string",
};

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return value === null ? "null" : typeof value;
}

function fieldAt(record: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
}

/** One readable line per field that is not what the API reads. */
export function shapeDiff(record: unknown, shape: Shape): string[] {
  return Object.entries(shape).flatMap(([path, expected]) => {
    const actual = typeOf(fieldAt(record, path));
    if (actual === expected) return [];
    return actual === "undefined"
      ? [`missing ${path} (expected ${expected})`]
      : [`${path} is ${actual} (expected ${expected})`];
  });
}

export interface ContractResponse {
  body: unknown;
  hasLatestLedger: boolean;
}

/** One GET; null is a 404. */
export type ContractGet = (path: string) => Promise<ContractResponse | null>;

function recordsOf(body: unknown): unknown[] | null {
  const records = fieldAt(body, "_embedded.records");
  return Array.isArray(records) ? records : null;
}

class Check {
  readonly problems: string[] = [];

  constructor(private readonly get: ContractGet) {}

  /** `route` is the printed template; only `path` holds a real address. */
  private async read(route: string, path: string): Promise<ContractResponse | null> {
    try {
      const response = await this.get(path);
      if (response === null) this.problems.push(`${route}: answered 404`);
      return response;
    } catch (error) {
      const kind = error instanceof UpstreamError ? error.kind : "unavailable";
      this.problems.push(`${route}: no answer (${kind})`);
      return null;
    }
  }

  private fields(route: string, record: unknown, shape: Shape): void {
    this.problems.push(...shapeDiff(record, shape).map((line) => `${route}: ${line}`));
  }

  private ledgerHeader(route: string, response: ContractResponse): void {
    if (!response.hasLatestLedger) this.problems.push(`${route}: missing Latest-Ledger header`);
  }

  async record(route: string, path: string, shape: Shape, ledger: boolean): Promise<void> {
    const response = await this.read(route, path);
    if (!response) return;
    this.fields(route, response.body, shape);
    if (ledger) this.ledgerHeader(route, response);
  }

  /** The first record, held to `shape`. Path finding alone is unpaged, and may have no route. */
  async collection(
    route: string,
    path: string,
    shape: Shape,
    options: { ledger?: boolean; unpagedMayBeEmpty?: boolean } = {}
  ): Promise<unknown> {
    const response = await this.read(route, path);
    if (!response) return undefined;
    if (options.ledger) this.ledgerHeader(route, response);
    const records = recordsOf(response.body);
    if (!records) {
      this.problems.push(`${route}: missing _embedded.records (expected array)`);
      return undefined;
    }
    if (records.length === 0) {
      if (!options.unpagedMayBeEmpty) this.problems.push(`${route}: no record to check against`);
      return undefined;
    }
    this.fields(route, records[0], shape);
    if (
      !options.unpagedMayBeEmpty &&
      typeOf(fieldAt(response.body, "_links.next.href")) !== "string"
    ) {
      this.problems.push(`${route}: missing _links.next.href (expected string)`);
    }
    return records[0];
  }

  async notFound(route: string, path: string): Promise<void> {
    try {
      if ((await this.get(path)) !== null) this.problems.push(`${route}: expected 404`);
    } catch (error) {
      const kind = error instanceof UpstreamError ? error.kind : "unavailable";
      this.problems.push(`${route}: expected 404, got no answer (${kind})`);
    }
  }
}

/** Every way this provider departs from the contract; empty when it holds. */
export async function checkProviderContract(network: Network, get: ContractGet): Promise<string[]> {
  const check = new Check(get);
  const issuer = WELL_KNOWN_ISSUERS[network];

  const offer = await check.collection("/offers", "/offers?limit=1&order=desc", OFFER);
  const seller = fieldAt(offer, "seller");
  if (typeof seller === "string") {
    await check.record("/accounts/{id}", `/accounts/${seller}`, ACCOUNT, true);
    await check.collection("/accounts/{id}/offers", `/accounts/${seller}/offers?limit=1`, OFFER, {
      ledger: true,
    });
    await check.collection(
      "/accounts/{id}/operations",
      `/accounts/${seller}/operations?limit=1&order=desc`,
      OPERATION
    );
  }

  const balance = await check.collection(
    "/claimable_balances",
    "/claimable_balances?limit=1&order=desc",
    CLAIMABLE_BALANCE
  );
  const claimant = fieldAt(balance, "claimants.0.destination");
  if (typeof claimant === "string") {
    await check.collection(
      "/claimable_balances?claimant",
      `/claimable_balances?claimant=${claimant}&limit=1`,
      CLAIMABLE_BALANCE,
      { ledger: true }
    );
  } else if (balance !== undefined) {
    check.problems.push("/claimable_balances: missing claimants.0.destination (expected string)");
  }
  const sponsor = fieldAt(balance, "sponsor");
  if (typeof sponsor === "string") {
    await check.collection(
      "/claimable_balances?sponsor",
      `/claimable_balances?sponsor=${sponsor}&limit=1`,
      CLAIMABLE_BALANCE
    );
  }

  await check.collection(
    "/assets?asset_issuer",
    `/assets?asset_issuer=${issuer}&limit=1`,
    ASSET_STATS
  );
  await check.collection(
    "/paths/strict-send",
    "/paths/strict-send?source_asset_type=credit_alphanum4&source_asset_code=USDC" +
      `&source_asset_issuer=${issuer}&source_amount=1&destination_assets=native`,
    PATH,
    { unpagedMayBeEmpty: true }
  );
  await check.notFound(
    "/accounts/{unknown}",
    `/accounts/${StrKey.encodeEd25519PublicKey(randomBytes(32))}`
  );

  return check.problems;
}

/** Reads through the shared client. The URL and headers go no further than this function. */
function providerGet(provider: ProviderEndpoint, network: Network): ContractGet {
  return async (path) => {
    let hasLatestLedger = false;
    const body = await upstreamGetJson<unknown>(provider.url, path, {
      target: "horizon",
      network,
      headers: provider.headers,
      deadline: createDeadline(REQUEST_BUDGET_MS),
      notFoundIsNull: true,
      onHeaders: (headers) => {
        hasLatestLedger = /^\d+$/.test(headers.get("Latest-Ledger")?.trim() ?? "");
      },
    });
    return body === null ? null : { body, hasLatestLedger };
  };
}

export interface ProviderReport {
  label: string;
  problems: string[];
}

/** Checks each provider of the list, in order and apart. */
export async function checkProviders(
  network: Network,
  providers: readonly ProviderEndpoint[],
  makeGet: (provider: ProviderEndpoint) => ContractGet = (p) => providerGet(p, network)
): Promise<ProviderReport[]> {
  const reports: ProviderReport[] = [];
  for (const [i, provider] of providers.entries()) {
    reports.push({
      label: `${network} provider ${i + 1} of ${providers.length}`,
      problems: await checkProviderContract(network, makeGet(provider)),
    });
  }
  return reports;
}
