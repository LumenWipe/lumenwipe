import { Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

// Validation rules for the playground custodial sign endpoint. Kept separate
// from the route handler so they can be unit-tested directly.

const ALLOWED_OPS = new Set([
  "setOptions",
  "manageData",
  "manageSellOffer",
  "pathPaymentStrictSend",
  "payment",
  "changeTrust",
  "accountMerge",
]);

export const MAX_FEE_STROOPS = 1_000_000; // 0.1 XLM

export interface SignValidationContext {
  demoPublic: string;
  /** demo + ephemeral issuers + persistent issuer + market maker */
  allowedDestinations: Set<string>;
}

export type SignValidationResult = { ok: true; tx: Transaction } | { ok: false; error: string };

export function validateSignRequest(
  xdrBase64: string,
  ctx: SignValidationContext
): SignValidationResult {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(xdrBase64, Networks.TESTNET);
  } catch {
    return { ok: false, error: "invalid_xdr" };
  }

  if (!(parsed instanceof Transaction)) {
    return { ok: false, error: "fee_bump_not_allowed" };
  }
  const tx = parsed;

  if (tx.source !== ctx.demoPublic) {
    return { ok: false, error: "source_not_allowed" };
  }

  if (Number(tx.fee) > MAX_FEE_STROOPS) {
    return { ok: false, error: "fee_too_high" };
  }

  for (const op of tx.operations) {
    if (!ALLOWED_OPS.has(op.type)) {
      return { ok: false, error: `op_not_allowed:${op.type}` };
    }

    if (op.source && op.source !== ctx.demoPublic) {
      return { ok: false, error: "op_source_not_allowed" };
    }

    if (
      op.type === "payment" ||
      op.type === "pathPaymentStrictSend" ||
      op.type === "accountMerge"
    ) {
      if (!ctx.allowedDestinations.has(op.destination as string)) {
        return { ok: false, error: "destination_not_allowed" };
      }
    }
  }

  return { ok: true, tx };
}
