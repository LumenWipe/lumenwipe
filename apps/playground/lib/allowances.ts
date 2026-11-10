import "server-only";
import {
  Networks,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
  type Keypair,
} from "@stellar/stellar-sdk";
import { verifyRevokeAllowanceTransaction } from "@lumenwipe/verify";
import { LumenWipeClient, type Allowance } from "@lumenwipe/sdk";
import { SOROBAN_RPC_TESTNET_URL, type SignerState } from "./horizon-submit";
import { XLM_SAC } from "./scenarios";
import type { RecordedAllowance } from "./session-store";
import { requiredWeight, signForWeight, type SigningKey } from "./signing";
import { assertRevokeTransaction } from "./verify-revoke";

// The allowances scenario's server side: reading the demo's allowances through the API's list,
// and revoking one the session recorded with the transaction the API builds for it. The demo key
// signs a revoke only once both checks accept it: the playground's own (lib/verify-revoke.ts) and
// the shared revoke anchor from `@lumenwipe/verify`, each held to the session record and never to
// the API's list.

/** The API calls a revoke makes, through `@lumenwipe/sdk` in production. */
export interface AllowanceApi {
  getAllowances: (address: string) => Promise<{ allowances: Allowance[] }>;
  revokeAllowance: (params: {
    owner: string;
    token: string;
    spender: string;
  }) => Promise<{ transaction: string }>;
  submit: (signedXdr: string) => Promise<{ hash: string }>;
}

/** The production AllowanceApi: the configured API through `@lumenwipe/sdk`, on testnet. */
export function sdkAllowanceApi(baseUrl: string, apiKey: string): AllowanceApi {
  const client = new LumenWipeClient({ baseUrl, apiKey, network: "testnet" });
  return {
    getAllowances: (address) => client.getAllowances(address),
    revokeAllowance: (params) => client.revokeAllowance(params),
    submit: (signedXdr) => client.submit(signedXdr),
  };
}

/** A recorded allowance, with whether the API's list shows it and the live amount it read. */
export interface ListedAllowance {
  /** Its spender's position in the record, from 1, which names its scene node. */
  index: number;
  token: string;
  spender: string;
  /** Whether the API's list includes it. */
  listed: boolean;
  /** The live amount the API read, in stroops; null when it did not list it. */
  amount: string | null;
}

/**
 * Every allowance the session recorded, in the record's order, each marked with whether the API's
 * list shows it. The list is best effort (its event scan and its reads run on a time budget, and
 * on testnet it can miss a fresh approval), so what is revoked is the record, never the list: one
 * the API lists that the session did not record is left out, and nothing acts on it.
 */
export function recordedListed(
  listed: readonly Allowance[],
  recorded: readonly RecordedAllowance[]
): ListedAllowance[] {
  return recorded.map((r, i) => {
    const found = listed.find((a) => a.token === r.token && a.spender === r.spender);
    return {
      index: i + 1,
      token: r.token,
      spender: r.spender,
      listed: found !== undefined,
      amount: found?.amount ?? null,
    };
  });
}

export class RevokeSignatureShortError extends Error {
  constructor() {
    super("The demo's keys cannot reach the weight the revoke needs");
    this.name = "RevokeSignatureShortError";
  }
}

export interface RevokeOptions {
  demo: Keypair;
  /** The session's recorded signers the playground holds a secret for, as for the close. */
  signingKeys: readonly SigningKey[];
  /** Every allowance the session recorded. */
  recorded: readonly RecordedAllowance[];
  /** The one to revoke, taken from `recorded`. */
  allowance: RecordedAllowance;
  api: AllowanceApi;
  signerState: (address: string) => Promise<SignerState>;
  now?: () => number;
}

function parseOwn(envelope: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) throw new Error("Unexpected fee-bump revoke from the API");
  return parsed;
}

/**
 * Revokes one recorded allowance: asks the API for the unsigned `approve(demo, spender, 0, ...)`,
 * holds it to both checks, signs it with the demo key (and the session's recorded signers when
 * the account's thresholds need them), and submits it through the API. Returns the hash computed
 * from the envelope the playground signed, never the one the API reports.
 */
export async function revokeRecordedAllowance(opts: RevokeOptions): Promise<string> {
  const demoPublic = opts.demo.publicKey();
  const { allowance } = opts;
  const isRecorded = opts.recorded.some(
    (r) => r.token === allowance.token && r.spender === allowance.spender
  );
  if (allowance.token !== XLM_SAC || !isRecorded) {
    throw new Error("Only an allowance the session recorded on the pinned token is revoked");
  }
  const { transaction } = await opts.api.revokeAllowance({
    owner: demoPublic,
    token: allowance.token,
    spender: allowance.spender,
  });
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const tx = parseOwn(transaction);
  assertRevokeTransaction(
    tx,
    { demoPublic, spenders: opts.recorded.map((r) => r.spender) },
    nowSeconds
  );
  verifyRevokeAllowanceTransaction(
    transaction,
    Networks.TESTNET,
    { owner: demoPublic, token: XLM_SAC, spender: allowance.spender },
    nowSeconds
  );

  const state = await opts.signerState(demoPublic);
  const required = requiredWeight(tx, state);
  if (signForWeight(tx, opts.demo, opts.signingKeys, state, required) < required) {
    throw new RevokeSignatureShortError();
  }
  const hash = Buffer.from(tx.hash()).toString("hex");
  await opts.api.submit(tx.toEnvelope().toXDR("base64"));
  return hash;
}

/** The ledger an `approve` is checked against and the longest TTL an entry may be given. */
export interface LedgerTtl {
  latestLedger: number;
  maxEntryTtl: number;
}

/** Reads the latest ledger and the network's maximum entry TTL from the testnet RPC. */
export async function readLedgerTtl(
  server: Pick<rpc.Server, "getLedgerEntries"> = new rpc.Server(SOROBAN_RPC_TESTNET_URL)
): Promise<LedgerTtl> {
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
    })
  );
  const res = await server.getLedgerEntries(key);
  const data = res.entries[0]?.val;
  if (data?.type !== "configSetting" || data.configSetting.type !== "configSettingStateArchival") {
    throw new Error("The RPC returned no state archival settings");
  }
  const maxEntryTtl = data.configSetting.stateArchivalSettings.maxEntryTtl;
  if (!Number.isInteger(maxEntryTtl) || maxEntryTtl <= 0 || !(res.latestLedger > 0)) {
    throw new Error("The RPC returned an unreadable ledger or TTL");
  }
  return { latestLedger: res.latestLedger, maxEntryTtl };
}
