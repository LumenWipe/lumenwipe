import { StrKey } from "@stellar/stellar-sdk";
import { LabRefusal } from "./home";
import { NETWORKS, type Network } from "./scenarios";

/** The most native balance a lab source account may hold. The config can lower it, never raise it. */
export const MAX_BALANCE_CAP_XLM = "100";

const AMOUNT = /^\d+(\.\d{1,7})?$/;

export function toStroops(amount: string): bigint {
  if (!AMOUNT.test(amount)) throw new LabRefusal(`not an XLM amount: ${JSON.stringify(amount)}`);
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

/** There is no default network: a destructive run names the one it spends on. */
export function requireNetwork(value: string | undefined): Network {
  if (value === undefined || value === "") {
    throw new LabRefusal("e2e needs --network testnet or --network mainnet; there is no default");
  }
  if (!(NETWORKS as readonly string[]).includes(value)) {
    throw new LabRefusal(`unknown network ${JSON.stringify(value)}`);
  }
  return value as Network;
}

export function resolveBalanceCap(configured: string | number | undefined): string {
  const cap = configured === undefined ? MAX_BALANCE_CAP_XLM : String(configured);
  const stroops = toStroops(cap);
  if (stroops <= 0n || stroops > toStroops(MAX_BALANCE_CAP_XLM)) {
    throw new LabRefusal(`balanceCapXlm must be above 0 and at most ${MAX_BALANCE_CAP_XLM} XLM`);
  }
  return cap;
}

/** Refuses a source holding more native balance than the cap. */
export function assertUnderBalanceCap(nativeBalance: string, capXlm: string): void {
  if (toStroops(nativeBalance) > toStroops(capXlm)) {
    throw new LabRefusal(
      `the source holds ${nativeBalance} XLM, above the ${capXlm} XLM cap; the lab only closes disposable accounts`
    );
  }
}

export function assertDestinationAllowed(
  destination: string | undefined,
  source: string,
  allowlist: readonly string[]
): string {
  if (!destination) throw new LabRefusal("e2e needs --destination");
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new LabRefusal("the destination is not a valid account address");
  }
  if (destination === source) throw new LabRefusal("the destination is the source itself");
  if (!allowlist.includes(destination)) {
    throw new LabRefusal("the destination is not on the e2e.destinations allowlist in config.json");
  }
  return destination;
}

export function confirmationPhrase(source: string): string {
  return `CLOSE ${source.slice(-6)}`;
}

/** The typed confirmation: only from a person at a terminal, and only the exact phrase. */
export function assertConfirmed(typed: string | null, source: string, isTTY: boolean): void {
  if (!isTTY) throw new LabRefusal("--submit needs a terminal: the confirmation cannot be piped");
  if (typed === null || typed.trim() !== confirmationPhrase(source)) {
    throw new LabRefusal("the confirmation did not match; nothing was signed");
  }
}

export interface SignerState {
  address: string;
  signers: readonly { key: string; type: string; weight: number }[];
  thresholds: { low: number; med: number; high: number };
}

/** Lab accounts are signed by their own key alone, with the weight for every operation. */
export function masterWeight(state: SignerState): number {
  const [only, ...rest] = state.signers;
  if (
    !only ||
    rest.length > 0 ||
    only.key !== state.address ||
    only.type !== "ed25519_public_key"
  ) {
    throw new LabRefusal("the source must have its own key as its only signer");
  }
  if (only.weight < Math.max(1, state.thresholds.high)) {
    throw new LabRefusal("the source key alone does not meet the account's high threshold");
  }
  return only.weight;
}

export interface LedgerAccount extends Omit<SignerState, "address"> {
  nativeBalance: string;
}

/** The API's read of the source must agree with Horizon's on everything the signature relies on:
 *  the balance the verifier holds the forward to, the signers and the thresholds. */
export function assertMatchesLedger(
  api: { nativeBalanceLumens: string } & Omit<SignerState, "address">,
  ledger: LedgerAccount
): void {
  const signers = (list: SignerState["signers"]) =>
    list
      .map((s) => `${s.type}:${s.key}:${s.weight}`)
      .sort()
      .join(",");
  const t = (x: SignerState["thresholds"]) => `${x.low}/${x.med}/${x.high}`;
  if (
    toStroops(api.nativeBalanceLumens) !== toStroops(ledger.nativeBalance) ||
    signers(api.signers) !== signers(ledger.signers) ||
    t(api.thresholds) !== t(ledger.thresholds)
  ) {
    throw new LabRefusal("the API's read of the source disagrees with Horizon; refusing");
  }
}
