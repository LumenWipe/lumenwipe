import { intentFromXdr } from "./intent/serialize";

/** Same cap and reasoning as verify.ts's own Soroban-invocation checks: the fee comes from the
 *  API's simulation, the one field here the client cannot predict or re-derive itself, so it is
 *  bounded rather than trusted outright. Mirrors the API's own MAX_SOROBAN_EXIT_FEE_STROOPS. */
const MAX_REVOKE_FEE_STROOPS = BigInt(10_000_000);

/** The same expiry window `verify()` holds a close transaction to. */
const MAX_VALIDITY_SECONDS = BigInt(900);

/**
 * The trust anchor for one allowance revocation (#163, architecture.md §12) - independent of the
 * account-close flow, so it does not go through `verify()`/`assertCloseIntent`'s close-shaped
 * allowlist. Every expected value is exactly what the inspector table already rendered on screen
 * before the user clicked "Revoke" - unlike the close flow's own inputs (a destination, an
 * amount), which the user chooses and types themselves, `{owner, token, spender}` here describe
 * something the API's own discovery endpoint found, not something independent of any API call.
 * What this anchor actually guarantees is narrower and still real: the signed transaction does
 * exactly what the screen the user looked at said it would, so a compromised or buggy API cannot
 * silently substitute a different token or spender between "what was shown" and "what gets
 * signed." Soroban's own authorization scoping is what keeps the residual bounded even if the
 * discovered `{token, spender}` pair itself were wrong or hostile: `approve(owner, spender, 0, _)`
 * can only ever zero out one specific allowance, never move the account's actual balance.
 */

/**
 * Every reason the revocation anchor refuses a transaction, one stable code each, in the order the
 * checks run. The code is the contract an integrator branches on; the message is the current
 * English wording and may change. Each code carries a `revoke_` prefix so it never shares a value
 * with a close `VerificationErrorCode`.
 */
export const REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES = [
  "revoke_expiry_missing",
  "revoke_expiry_too_far",
  "revoke_transaction_source_mismatch",
  "revoke_memo_present",
  "revoke_fee_above_cap",
  "revoke_operation_count",
  "revoke_operation_source_mismatch",
  "revoke_not_invocation",
  "revoke_token_mismatch",
  "revoke_function_not_approve",
  "revoke_approve_args_mismatch",
  "revoke_auth_beyond_self",
  "revoke_auth_nested",
  "revoke_address_unsupported",
  "revoke_foreign_account",
  "revoke_foreign_contract",
] as const;

/** The reason a {@link RevokeAllowanceVerificationError} was thrown. */
export type RevokeAllowanceVerificationErrorCode =
  (typeof REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES)[number];

/** Thrown when a server-built allowance revocation fails verification. Never sign past this. */
export class RevokeAllowanceVerificationError extends Error {
  /** Why the transaction was refused. Stable across releases, unlike the message. */
  readonly code: RevokeAllowanceVerificationErrorCode;

  constructor(code: RevokeAllowanceVerificationErrorCode, message: string) {
    super(message);
    this.name = "RevokeAllowanceVerificationError";
    this.code = code;
  }
}

export interface RevokeAllowanceExpectation {
  owner: string;
  token: string;
  spender: string;
}

function fail(code: RevokeAllowanceVerificationErrorCode, message: string): never {
  throw new RevokeAllowanceVerificationError(code, message);
}

export function verifyRevokeAllowanceTransaction(
  xdr: string,
  networkPassphrase: string,
  expected: RevokeAllowanceExpectation,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  const intent = intentFromXdr(xdr, networkPassphrase);
  const maxTime = intent.maxTime ?? null;
  if (maxTime === null || !/^\d+$/.test(maxTime)) {
    fail(
      "revoke_expiry_missing",
      "This transaction never expires, so it could be submitted long after you approved it."
    );
  }
  if (BigInt(maxTime) > BigInt(Math.floor(nowSeconds)) + MAX_VALIDITY_SECONDS) {
    fail(
      "revoke_expiry_too_far",
      "This transaction stays valid for far longer than a revocation needs."
    );
  }
  if (intent.source !== expected.owner) {
    fail(
      "revoke_transaction_source_mismatch",
      "This transaction is not sourced from the account being revoked for."
    );
  }
  if (intent.memo !== null) {
    fail("revoke_memo_present", "This transaction carries a memo, which a revocation never needs.");
  }
  if (BigInt(intent.fee) > MAX_REVOKE_FEE_STROOPS) {
    fail(
      "revoke_fee_above_cap",
      "This transaction's fee is higher than a revocation should ever need."
    );
  }
  if (intent.operations.length !== 1) {
    fail(
      "revoke_operation_count",
      `This transaction has ${intent.operations.length} operations; a revocation has exactly one.`
    );
  }
  const op = intent.operations[0]!;
  if (op.source !== expected.owner) {
    fail(
      "revoke_operation_source_mismatch",
      "The operation does not act as the account being revoked for."
    );
  }
  if (op.type !== "invoke_host_function") {
    fail("revoke_not_invocation", "This transaction does not invoke a contract.");
  }
  if (op.contract !== expected.token) {
    fail("revoke_token_mismatch", "This transaction does not touch the expected token contract.");
  }
  if (op.function !== "approve") {
    fail(
      "revoke_function_not_approve",
      "This transaction does not call approve, so it is not a revocation."
    );
  }
  if (
    op.args.length !== 4 ||
    op.args[0] !== expected.owner ||
    op.args[1] !== expected.spender ||
    op.args[2] !== "0"
  ) {
    fail(
      "revoke_approve_args_mismatch",
      "This transaction does not revoke the expected spender's allowance on this token."
    );
  }
  if (op.authorizesBeyondSelf) {
    fail(
      "revoke_auth_beyond_self",
      "This transaction authorizes more than the account's own revocation."
    );
  }
  if (op.authDepth !== 0) {
    fail(
      "revoke_auth_nested",
      "This transaction authorizes a nested call, which a plain revocation never needs."
    );
  }
  if (op.unsupportedAddressCount > 0) {
    fail(
      "revoke_address_unsupported",
      "This transaction references an address form that cannot be verified."
    );
  }
  // The spender can legitimately be either kind of address (see the `spender` field's own
  // comment in packages/types/src/allowance.ts) - describeInvocation buckets a G... address into
  // accountsReferenced and a C... address into contractsReferenced, so it is allowed in both
  // checks below; only one of the two will ever actually contain it for a given spender.
  if (op.accountsReferenced.some((a) => a !== expected.owner && a !== expected.spender)) {
    fail(
      "revoke_foreign_account",
      "This transaction references an account other than the one being revoked for."
    );
  }
  if (op.contractsReferenced.some((c) => c !== expected.token && c !== expected.spender)) {
    fail(
      "revoke_foreign_contract",
      "This transaction references a contract other than the token or the spender."
    );
  }
}
