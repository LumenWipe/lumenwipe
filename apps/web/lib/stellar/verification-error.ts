/**
 * Every reason the verifier refuses a transaction, one stable code each. The code is the contract
 * an integrator branches on; the message is the current English wording and may change. A check
 * that applies to several operation kinds (the fee cap, the operation source) shares one code,
 * since the kind is visible in the transaction itself.
 */
export const VERIFICATION_ERROR_CODES = [
  // The transaction as a whole
  "registry_expired",
  "transaction_source_mismatch",
  "expiry_missing",
  "expiry_too_far",
  "fee_unreadable",
  "fee_above_cap",
  "operation_unknown",
  "operation_source_mismatch",
  // The account merge and the mediator hand-off
  "merge_multiple",
  "merge_direct_refused",
  "merge_destination_mismatch",
  "mediator_handoff_shape",
  "mediator_forward_source_mismatch",
  "mediator_forward_destination_mismatch",
  "mediator_forward_not_native",
  "mediator_forward_short",
  // Classic and token transfers
  "transfer_not_chosen",
  "transfer_destination_mismatch",
  "transfer_to_deposit_address",
  "transfer_duplicate",
  "transfer_amount_short",
  "token_transfer_function_invalid",
  "token_transfer_from_mismatch",
  "token_transfer_foreign_contract",
  // Classic conversions and token swaps
  "conversion_recipient_mismatch",
  "conversion_not_to_xlm",
  "conversion_min_out_missing",
  "conversion_asset_not_chosen",
  "conversion_duplicate",
  "conversion_min_out_below_floor",
  "conversion_amount_short",
  "swap_quote_missing",
  "swap_args_unreadable",
  "swap_referral_recipient",
  "swap_route_asset_unknown",
  "swap_auth_unexpected_call",
  "swap_auth_exceeds_amount",
  // Removals and SetOptions
  "trustline_not_removal",
  "data_entry_not_removal",
  "offer_not_cancellation",
  "signer_added",
  "signer_unknown",
  "master_weight_changed",
  "thresholds_raised",
  "account_settings_changed",
  // Rules shared by every contract invocation
  "invocation_not_alone",
  "invocation_auth_beyond_self",
  "invocation_address_unsupported",
  "invocation_foreign_account",
  // DeFi exits
  "exit_contract_not_position",
  "exit_expectation_inconsistent",
  "exit_function_not_allowed",
  "exit_foreign_contract",
  "exit_argument_party_mismatch",
  "exit_request_not_allowed",
  "exit_unverified_spend",
  "exit_spend_not_repay",
  "exit_liquidity_auth_invalid",
  "exit_auth_foreign_contract",
  "exit_token_function_not_allowed",
  "exit_token_argument_count",
  "exit_token_recipient_mismatch",
  // The memo
  "memo_unexpected",
  "memo_type_unreadable",
  "memo_missing",
  "memo_value_mismatch",
  "memo_type_mismatch",
  "memo_required",
  "memo_invalid_text",
] as const;

/** The reason a {@link VerificationError} was thrown. */
export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

/** Thrown when a server-built close transaction fails verification. Never sign past this. */
export class VerificationError extends Error {
  /** Why the transaction was refused. Stable across releases, unlike the message. */
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}
