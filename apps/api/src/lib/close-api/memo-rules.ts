import type { Memo, MemoType as EnvelopeMemoType } from "@stellar/stellar-sdk";
import type { RegistryEntry } from "@/lib/exchange-registry";

export type MemoType = RegistryEntry["memoType"];

export interface MemoRule {
  required: boolean;
  memoType: MemoType;
  /** From the registry, so the memo must be exactly this type. An unlisted destination states
   *  only that it needs a memo, never which kind. */
  fixedType: boolean;
  source: "registry" | "account" | null;
}

export interface MemoProblem {
  code: "memo_required" | "unsupported_memo_type" | "invalid_memo";
  message: string;
  details?: Record<string, unknown>;
}

const UINT64_MAX = 18446744073709551615n;
const TEXT_MEMO_MAX_BYTES = 28;

/** `requested` is the type the caller named, used only where the registry names none. */
export function memoRuleFor(
  exchange: RegistryEntry | null,
  requiredOnChain: boolean,
  requested: MemoType | null = null
): MemoRule {
  const byRegistry = exchange?.requiresMemo ?? false;
  return {
    required: byRegistry || requiredOnChain,
    memoType: exchange?.memoType ?? requested ?? "text",
    fixedType: exchange !== null,
    source: byRegistry ? "registry" : requiredOnChain ? "account" : null,
  };
}

function missing(rule: MemoRule): MemoProblem {
  if (rule.source === "account") {
    return {
      code: "memo_required",
      message:
        "This destination account states on the network that every payment to it needs a " +
        "memo. Add the memo it gave you, such as an exchange deposit memo, and retry.",
      details: { memoType: rule.memoType },
    };
  }
  return {
    code: "memo_required",
    message: "This exchange destination requires a deposit memo.",
    details: { memoType: rule.memoType },
  };
}

function valueProblem(memo: string, memoType: MemoType): MemoProblem | null {
  if (memoType === "hash") {
    return { code: "unsupported_memo_type", message: "Hash memos are not supported." };
  }
  if (memoType === "id" && !(/^\d+$/.test(memo) && BigInt(memo) <= UINT64_MAX)) {
    return {
      code: "invalid_memo",
      message: "This destination requires a numeric id memo within the uint64 range.",
    };
  }
  // The network keeps the number, so "007" would be sent as 7 and no longer be the memo given.
  if (memoType === "id" && memo.length > 1 && memo.startsWith("0")) {
    return { code: "invalid_memo", message: "An id memo cannot start with 0." };
  }
  if (memoType === "text" && Buffer.byteLength(memo, "utf8") > TEXT_MEMO_MAX_BYTES) {
    return { code: "invalid_memo", message: "A text memo must be at most 28 bytes." };
  }
  return null;
}

/** A blank memo is no memo: it would credit nobody, so it never satisfies a requirement. */
export function normalizeRequestMemo(raw: unknown): { memo: string | null } | MemoProblem {
  if (raw === undefined || raw === null) return { memo: null };
  if (typeof raw !== "string") {
    return { code: "invalid_memo", message: "A memo must be a string." };
  }
  return { memo: raw.trim() === "" ? null : raw };
}

/** The memo type a request names, null when it names none, or undefined when the field is not
 *  one of the memo types at all. */
export function parseRequestMemoType(raw: unknown): MemoType | null | undefined {
  if (raw === undefined || raw === null) return null;
  return raw === "text" || raw === "id" || raw === "hash" ? raw : undefined;
}

/** Why the named memo type cannot go with this memo to this destination. A listed exchange's
 *  type is the registry's: a caller naming another is refused rather than overridden, so it
 *  learns that the memo it holds is not the kind the exchange credits. */
export function requestMemoTypeProblem(
  memo: string | null,
  requested: MemoType | null,
  exchange: RegistryEntry | null
): MemoProblem | null {
  if (memo === null || requested === null) return null;
  if (requested === "hash") {
    return { code: "unsupported_memo_type", message: "Hash memos are not supported." };
  }
  if (exchange !== null && requested !== exchange.memoType) {
    return {
      code: "invalid_memo",
      message: `This destination requires ${exchange.memoType === "id" ? "an id" : `a ${exchange.memoType}`} memo.`,
      details: { memoType: exchange.memoType },
    };
  }
  return null;
}

/** Whether the destination's own ledger entry must be read: only when the registry has not
 *  already required a memo and the memo at hand would not satisfy an account that asks for one. */
export function needsLedgerMemoRead(
  exchange: RegistryEntry | null,
  memoSatisfiesAccountRule: boolean
): boolean {
  return !(exchange?.requiresMemo ?? false) && !memoSatisfiesAccountRule;
}

export function requestMemoProblem(memo: string | null, rule: MemoRule): MemoProblem | null {
  if (memo === null) return rule.required ? missing(rule) : null;
  return valueProblem(memo, rule.memoType);
}

function envelopeMemoIsEmpty(memo: Memo<EnvelopeMemoType>): boolean {
  if (memo.type === "none" || memo.value === null || memo.value === undefined) return true;
  if (memo.type !== "text") return false;
  const text = typeof memo.value === "string" ? memo.value : Buffer.from(memo.value).toString();
  return text.replace(/\0/g, "").trim() === "";
}

export function envelopeMemoSatisfiesAccountRule(memo: Memo<EnvelopeMemoType>): boolean {
  return !envelopeMemoIsEmpty(memo) && (memo.type === "text" || memo.type === "id");
}

export function envelopeMemoProblem(
  memo: Memo<EnvelopeMemoType>,
  rule: MemoRule
): MemoProblem | null {
  if (envelopeMemoIsEmpty(memo)) return rule.required ? missing(rule) : null;
  if (rule.fixedType) {
    if (rule.memoType === "hash" || memo.type === "hash" || memo.type === "return") {
      return { code: "unsupported_memo_type", message: "Hash memos are not supported." };
    }
    if (memo.type !== rule.memoType) {
      return {
        code: "invalid_memo",
        message: `This destination requires a ${rule.memoType} memo.`,
        details: { memoType: rule.memoType },
      };
    }
    return null;
  }
  if (rule.required && memo.type !== "text" && memo.type !== "id") {
    return {
      code: "unsupported_memo_type",
      message: "This destination needs a text or id memo.",
    };
  }
  return null;
}
