import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { IntentOperation } from "@/types/close-api";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { toHex } from "@/lib/stellar/hex";
import { memoLine, type MemoLine } from "@/lib/plan/destination-kind";

/** One operation as the SDK decodes it from the envelope. */
type RawOperation = Transaction["operations"][number];

/** One operation of a transaction, in words, with the account it acts as. */
export interface OperationLine {
  label: string;
  source: string;
}

/** What a transaction does, read from its own envelope for a person to review. */
export interface TransactionSummary {
  source: string;
  operations: OperationLine[];
  /** Where an account merge in it sends the balance, or null without one. */
  mergeDestination: string | null;
  /** The memo with its type, as the review screen shows one. */
  memo: MemoLine;
  /** The fee the transaction offers, in XLM. */
  feeXlm: string;
  sequence: string;
  /** When it can land: "no time limit", or its window in UTC. */
  validity: string;
}

const STROOPS_PER_XLM = BigInt(10_000_000);

function xlm(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / STROOPS_PER_XLM;
  const fraction = (value % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

function utc(seconds: string): string {
  return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ");
}

function validityOf(timeBounds: { minTime: string; maxTime: string } | undefined): string {
  const min = timeBounds && timeBounds.minTime !== "0" ? timeBounds.minTime : null;
  const max = timeBounds && timeBounds.maxTime !== "0" ? timeBounds.maxTime : null;
  if (!min && !max) return "no time limit";
  if (min && max) return `from ${utc(min)} until ${utc(max)}`;
  return min ? `from ${utc(min)}, with no end` : `until ${utc(max!)}`;
}

/** A raw amount in the token's smallest unit, grouped by thousands. */
function groupDigits(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  return `${negative ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** A contract call's argument with its type, never hidden. */
function argumentOf(value: xdr.ScVal): string {
  const type = value.type.replace(/^scv/, "").toLowerCase();
  try {
    if (value.type === "scvAddress") {
      return `address ${Address.fromScAddress(value.address).toString()}`;
    }
    const native: unknown = scValToNative(value);
    const shown =
      typeof native === "bigint" || typeof native === "number" || typeof native === "string"
        ? native.toString()
        : JSON.stringify(native, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    return `${type} ${shown}`;
  } catch {
    return `${type} ${value.toXdr("base64")}`;
  }
}

/** A token `transfer(from, to, amount)` or `approve(from, spender, amount, expiration)`, read in
 *  words; null for any other shape. */
function tokenCall(fn: string, args: xdr.ScVal[]): string | null {
  const isAddress = (v: xdr.ScVal | undefined) => v?.type === "scvAddress";
  const isI128 = (v: xdr.ScVal | undefined) => v?.type === "scvI128";
  const address = (v: xdr.ScVal) =>
    v.type === "scvAddress" ? Address.fromScAddress(v.address).toString() : "";
  const amount = (v: xdr.ScVal) => groupDigits(String(scValToNative(v)));
  if (
    fn === "transfer" &&
    args.length === 3 &&
    isAddress(args[0]) &&
    isAddress(args[1]) &&
    isI128(args[2])
  ) {
    return `from ${address(args[0]!)} to ${address(args[1]!)}, amount ${amount(args[2]!)} in the token's smallest unit`;
  }
  if (
    fn === "approve" &&
    args.length === 4 &&
    isAddress(args[0]) &&
    isAddress(args[1]) &&
    isI128(args[2]) &&
    args[3]?.type === "scvU32"
  ) {
    return `from ${address(args[0]!)} for spender ${address(args[1]!)}, amount ${amount(args[2]!)} in the token's smallest unit, until ledger ${String(scValToNative(args[3]!))}`;
  }
  return null;
}

function describeCall(fn: string, contract: string, raw: RawOperation | undefined): string {
  const args =
    raw?.type === "invokeHostFunction" && raw.func.type === "hostFunctionTypeInvokeContract"
      ? raw.func.invokeContract.args
      : [];
  const head = `Call ${fn} on contract ${contract}`;
  if (args.length === 0) return `${head}, with no arguments`;
  return `${head}: ${tokenCall(fn, args) ?? `arguments ${args.map(argumentOf).join("; ")}`}`;
}

function assetName(asset: string): string {
  return asset === "native" ? "XLM" : asset;
}

/** One operation in words. Every type the close vocabulary knows is described; anything else is
 *  named by its raw type, never dropped. */
export function describeOperation(op: IntentOperation, raw: RawOperation | undefined): string {
  const rawType = raw?.type ?? "";
  switch (op.type) {
    case "path_payment_strict_send":
      return `Convert ${op.sendAmount} ${assetName(op.sendAsset)} into at least ${op.destMin} ${assetName(op.destAsset)}, sent to ${op.destination}`;
    case "payment":
      return `Pay ${op.amount} ${assetName(op.asset)} to ${op.destination}`;
    case "change_trust":
      return Number(op.limit) === 0
        ? `Remove the ${op.asset} trustline`
        : `Set the ${op.asset} trustline limit to ${op.limit}`;
    case "account_merge":
      return `Merge account ${op.source} into ${op.destination}`;
    case "manage_sell_offer":
      return Number(op.amount) === 0
        ? `Cancel offer ${op.offerId}`
        : `Change offer ${op.offerId} to sell ${op.amount}`;
    case "manage_data":
      return op.value === null ? `Delete data entry "${op.name}"` : `Set data entry "${op.name}"`;
    case "set_options":
      return describeSetOptions(op);
    case "claim_claimable_balance":
      return `Claim balance ${op.balanceId}`;
    case "revoke_sponsorship":
      return `Revoke the sponsorship of a ${op.entryKind.replace("_", " ")} of ${op.owner}`;
    case "invoke_host_function":
      return describeCall(op.function, op.contract, raw);
    default: {
      // "unknown", and any type added to the vocabulary before it is described here: named by
      // its raw type, so the list still shows every operation.
      op.type satisfies "unknown";
      return `Unrecognized operation (${rawType})`;
    }
  }
}

function describeSetOptions(op: Extract<IntentOperation, { type: "set_options" }>): string {
  const parts: string[] = [];
  if (op.signer) {
    parts.push(
      op.signer.weight === 0
        ? `remove signer ${op.signer.key}`
        : `set signer ${op.signer.key} to weight ${op.signer.weight}`
    );
  }
  if (op.masterWeight !== null) parts.push(`set the master key weight to ${op.masterWeight}`);
  const thresholds = [
    ["low", op.lowThreshold],
    ["medium", op.medThreshold],
    ["high", op.highThreshold],
  ].filter(([, value]) => value !== null);
  if (thresholds.length > 0) {
    parts.push(
      `set thresholds ${thresholds.map(([name, value]) => `${name} ${value}`).join(", ")}`
    );
  }
  if (op.homeDomain !== null) parts.push(`set the home domain to "${op.homeDomain}"`);
  if (op.setFlags !== null) parts.push(`set flags ${op.setFlags}`);
  if (op.clearFlags !== null) parts.push(`clear flags ${op.clearFlags}`);
  if (op.inflationDest !== null) parts.push(`set the inflation destination to ${op.inflationDest}`);
  return parts.length > 0 ? `Set options: ${parts.join("; ")}` : "Set options, changing nothing";
}

function memoOf(
  memo: { type: string; value: unknown },
  value: string | null,
  type: "text" | "id" | "hash" | null
): MemoLine {
  if (type !== null && value !== null) return memoLine({ memo: value, memoType: type });
  if (memo.type === "return" && memo.value instanceof Uint8Array) {
    return { label: "return", value: toHex(memo.value), bytes: null };
  }
  return memoLine(null);
}

/**
 * What `xdr` does, decoded from the envelope itself: its source, every operation in order, the
 * merge destination and the memo. For a person's review only; it checks nothing. Throws when the
 * envelope cannot be read.
 */
export function summarizeTransaction(xdr: string, passphrase: string): TransactionSummary {
  const tx = TransactionBuilder.fromXdr(xdr, passphrase);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const intent = intentFromXdr(inner.toXDR(), passphrase);
  return {
    source: intent.source,
    operations: intent.operations.map((op, i) => ({
      label: describeOperation(op, inner.operations[i]),
      source: op.source,
    })),
    mergeDestination: intent.guarantees.mergeDestination,
    memo: memoOf(inner.memo, intent.memo, intent.memoType),
    feeXlm: xlm(inner.fee),
    sequence: inner.sequence,
    validity: validityOf(inner.timeBounds),
  };
}
