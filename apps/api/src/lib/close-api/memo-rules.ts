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

export function memoRuleFor(exchange: RegistryEntry | null, requiredOnChain: boolean): MemoRule {
  const byRegistry = exchange?.requiresMemo ?? false;
  return {
    required: byRegistry || requiredOnChain,
    memoType: exchange?.memoType ?? "text",
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
