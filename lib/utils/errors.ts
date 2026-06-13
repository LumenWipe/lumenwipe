import { xdr } from "@stellar/stellar-sdk";

// ─── Message map ──────────────────────────────────────────────────────────────
// Keys are either:
//   - RPC status strings ("ERROR", "FAILED", "TIMEOUT")
//   - Horizon-style tx result codes ("tx_bad_auth", "op_no_trust", ...)
//   - camelCase XDR discriminant names converted to snake_case by extractFirstFailedOpCode

const RESULT_CODE_MESSAGES: Record<string, string> = {
  // ── RPC-level statuses ──────────────────────────────────────────────────────
  TIMEOUT: "The transaction was not confirmed within the timeout period. It is safe to retry.",
  ERROR: "The transaction was rejected by the network.",
  FAILED: "The transaction failed. Check individual operation results.",

  // ── Transaction-level codes ─────────────────────────────────────────────────
  tx_bad_auth:
    "The transaction signature does not meet the account's authorization requirements. Make sure you're using the correct secret key.",
  tx_insufficient_fee: "The network fee was too low. Please retry.",
  tx_bad_seq: "Sequence number mismatch. Please retry - the account state has changed.",
  tx_no_account: "The source account does not exist on the network.",
  tx_insufficient_balance: "Insufficient XLM balance to cover the transaction fee and reserves.",
  tx_missing_operation: "The transaction has no operations.",
  tx_too_early: "Transaction submitted too early - before its minimum time.",
  tx_too_late: "Transaction expired before it was confirmed. Please retry.",
  tx_internal_error: "An internal network error occurred. Please retry.",
  tx_bad_auth_extra: "The transaction has extra signatures that are not needed.",
  tx_not_supported: "This transaction type is not supported by this network.",

  // ── Generic operation-level codes ──────────────────────────────────────────
  op_no_trust: "This account does not have a trustline for the specified asset.",
  op_low_reserve:
    "Insufficient XLM balance to cover the minimum reserve requirement after this operation.",
  op_sell_no_issuer:
    "The asset issuer account no longer exists - sending balance back is not possible.",
  op_no_issuer: "The asset issuer account does not exist.",
  op_underfunded: "Insufficient balance for this operation.",
  op_bad_auth: "Insufficient authorization for this operation.",
  op_no_destination:
    "The destination account does not exist on this network. Make sure the destination address is funded before merging.",
  op_malformed: "The operation is malformed. Check that all parameters are valid.",
  op_already_exist:
    "The destination account already exists (AccountMerge cannot merge into itself).",
  op_not_authorized: "This account does not have authorization to perform this merge.",

  // ── PathPaymentStrictSend (CONVERT_ASSETS) ──────────────────────────────────
  path_payment_strict_send_too_few_offers:
    "No conversion path found between these assets. The market may have no liquidity - try sending the balance back to the issuer instead.",
  path_payment_strict_send_under_dest_min:
    "Slippage too high - received less XLM than the minimum. Please retry.",
  path_payment_strict_send_underfunded: "Insufficient asset balance for this conversion.",
  path_payment_strict_send_src_no_trust:
    "Source account does not have a trustline for the asset being sold.",
  path_payment_strict_send_src_not_authorized:
    "Source account is not authorized to send this asset.",
  path_payment_strict_send_no_destination: "The destination account does not exist.",
  path_payment_strict_send_no_trust:
    "This account does not have a trustline for the destination asset.",
  path_payment_strict_send_not_authorized:
    "This account is not authorized to hold the destination asset.",
  path_payment_strict_send_line_full: "Destination account's asset limit is full.",
  path_payment_strict_send_no_issuer:
    "An asset issuer account no longer exists along the conversion path.",
  path_payment_strict_send_offer_cross_self:
    "The conversion path crosses one of your own DEX offers.",
  path_payment_strict_send_malformed: "The conversion operation is malformed.",

  // ── ManageSellOffer (CANCEL_OFFERS) ─────────────────────────────────────────
  manage_sell_offer_not_found:
    "The offer was not found - it may have been filled or already cancelled.",
  manage_sell_offer_cross_self: "Cancelling this offer would cross another of your own orders.",
  manage_sell_offer_sell_no_issuer: "The issuer of the asset being sold no longer exists.",
  manage_sell_offer_buy_no_issuer: "The issuer of the asset being bought no longer exists.",
  manage_sell_offer_low_reserve: "Insufficient XLM balance to cover the reserve for this offer.",
  manage_sell_offer_underfunded: "Insufficient balance to cancel this offer.",
  manage_sell_offer_line_full: "The buying asset trustline is at its limit.",
  manage_sell_offer_sell_no_trust: "Seller does not have a trustline for the asset being sold.",
  manage_sell_offer_buy_no_trust: "Seller does not have a trustline for the asset being bought.",
  manage_sell_offer_malformed: "The offer operation is malformed.",

  // ── ChangeTrust (REMOVE_TRUSTLINES) ─────────────────────────────────────────
  change_trust_cannot_delete:
    "Cannot remove this trustline - it still has a non-zero balance. Convert or send the remaining balance first.",
  change_trust_low_reserve: "Insufficient XLM to cover the reserve for this trustline change.",
  change_trust_self_not_allowed: "Cannot create a trustline to your own issued asset.",
  change_trust_trust_line_missing: "Cannot remove a trustline that does not exist.",
  change_trust_not_auth_maintain_liabilities:
    "Trustline deauthorization would violate existing liabilities.",
  change_trust_invalid_limit: "The trustline limit is invalid.",

  // ── AccountMerge (MERGE) ────────────────────────────────────────────────────
  account_merge_malformed: "The account merge operation is malformed.",
  account_merge_no_account: "The destination account does not exist on this network.",
  account_merge_immutable_set: "This account has AUTH_IMMUTABLE set and cannot be merged.",
  account_merge_has_sub_entries:
    "This account still has open subentries (trustlines, offers, or data entries) and cannot be merged yet.",
  account_merge_seqnum_too_far: "Sequence number is too far ahead. Please retry.",
  account_merge_dest_full:
    "The destination account's XLM balance would exceed the network maximum.",
  account_merge_is_sponsor:
    "This account is sponsoring other accounts and cannot be merged until sponsorships are revoked.",

  // ── SetOptions (NORMALIZE_SIGNERS) ──────────────────────────────────────────
  set_options_low_reserve: "Insufficient XLM to cover the reserve for adding this signer.",
  set_options_bad_flags: "Invalid account flags.",
  set_options_cant_change: "Cannot modify account options - AUTH_IMMUTABLE is set.",
  set_options_bad_signer: "Invalid signer key.",
  set_options_threshold_out_of_range: "Threshold value is out of range.",
  set_options_auth_revocable_required: "AUTH_REVOCABLE must be set to perform this operation.",

  // ── ManageData (REMOVE_DATA_ENTRIES) ────────────────────────────────────────
  manage_data_name_not_found: "Data entry not found - it may have already been removed.",
  manage_data_low_reserve: "Insufficient XLM to cover the reserve for this data entry.",
  manage_data_invalid_name: "Invalid data entry name.",

  // ── ClaimClaimableBalance (CLAIM_BALANCES) ───────────────────────────────────
  claim_claimable_balance_does_not_exist:
    "This claimable balance no longer exists - it may have already been claimed by another claimant.",
  claim_claimable_balance_cannot_claim:
    "This claimable balance has a predicate (e.g. a time lock) that prevents claiming it right now.",
  claim_claimable_balance_line_full:
    "The trustline for the claimed asset is at its limit and cannot receive more.",
  claim_claimable_balance_no_trust:
    "No trustline exists for the asset in this claimable balance. Establish a trustline first.",
  claim_claimable_balance_not_authorized:
    "This account is not authorized to receive the asset in this claimable balance.",
  claim_claimable_balance_not_claimant:
    "This account is not listed as a claimant for this balance.",
  claim_claimable_balance_low_reserve:
    "Insufficient XLM to cover the reserve required to claim this balance.",
};

// ─── XDR result code extraction ───────────────────────────────────────────────

function camelToSnake(str: string): string {
  return str.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Parses a base64-encoded TransactionResult XDR and returns the first
 * meaningful failure code in snake_case. Returns null if parsing fails or
 * the result is a success.
 *
 * For txFailed (operation-level failures) it navigates into the first failing
 * OperationResult and surfaces the specific operation result code, e.g.
 * "path_payment_strict_send_too_few_offers". For transaction-level rejections
 * (txBadAuth, txTooLate, etc.) it returns that code directly.
 */
function extractFirstFailedOpCode(resultXdrBase64: string): string | null {
  try {
    const txResult = xdr.TransactionResult.fromXDR(resultXdrBase64, "base64");
    const txCode = (txResult.result().switch() as { name: string }).name;

    if (txCode !== "txFailed") {
      // Transaction-level failure (txBadAuth, txBadSeq, txTooLate, etc.)
      const code = camelToSnake(txCode);
      // Ignore success-ish variants
      return code === "tx_success" || code === "tx_fee_bump_inner_success" ? null : code;
    }

    // Operation-level failures
    for (const opResult of txResult.result().results()) {
      const opCode = (opResult.switch() as { name: string }).name;

      if (opCode !== "opInner") {
        return camelToSnake(opCode);
      }

      const tr = opResult.tr() as unknown as Record<
        string,
        () => { switch: () => { name: string } }
      >;
      const opType = (opResult.tr().switch() as { name: string }).name;

      try {
        const innerResult = tr[`${opType}Result`]?.();
        const resultCode = innerResult?.switch().name;
        if (resultCode && !resultCode.endsWith("Success") && !resultCode.endsWith("success")) {
          return camelToSnake(resultCode);
        }
      } catch {
        // Accessor failed - skip this op result
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function translateRpcError(code: string, raw?: string): string {
  // Direct map lookup for known codes (including op-level codes already extracted)
  const message = RESULT_CODE_MESSAGES[code];
  if (message) return message;

  // For ERROR/FAILED statuses, try to decode the TransactionResult XDR to get
  // a specific operation failure message instead of the generic fallback
  if ((code === "ERROR" || code === "FAILED") && raw) {
    const specificCode = extractFirstFailedOpCode(raw);
    if (specificCode) {
      const specificMessage = RESULT_CODE_MESSAGES[specificCode];
      if (specificMessage) return specificMessage;
      return `Transaction failed: ${specificCode.replace(/_/g, " ")}.`;
    }
  }

  return `An unexpected error occurred (code: ${code}).`;
}

export class AccountNotFoundError extends Error {
  constructor(address: string) {
    super(`Account ${address} does not exist on this network.`);
    this.name = "AccountNotFoundError";
  }
}

export class TxTimeoutError extends Error {
  constructor() {
    super("Transaction confirmation timed out. It is safe to retry.");
    this.name = "TxTimeoutError";
  }
}

export class NoConversionPathError extends Error {
  constructor(asset: string) {
    super(
      `No conversion path found for ${asset}. You may need to send the balance back to the issuer.`
    );
    this.name = "NoConversionPathError";
  }
}

export class FastPathUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FastPathUnavailableError";
  }
}

export class AssetRouteLostError extends Error {
  constructor(
    public readonly asset: string,
    public readonly assetCode: string
  ) {
    super(
      `The swap route for ${assetCode} is no longer available. Return it to the issuer to continue.`
    );
    this.name = "AssetRouteLostError";
  }
}
