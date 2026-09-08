import { intentFromXdr } from "./intent/serialize";

/** Same cap and reasoning as verify.ts's own Soroban-invocation checks: the fee comes from the
 *  API's simulation, the one field here the client cannot predict or re-derive itself, so it is
 *  bounded rather than trusted outright. Mirrors the API's own MAX_SOROBAN_EXIT_FEE_STROOPS. */
const MAX_REVOKE_FEE_STROOPS = BigInt(10_000_000);

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

export class RevokeAllowanceVerificationError extends Error {}

export interface RevokeAllowanceExpectation {
  owner: string;
  token: string;
  spender: string;
}

function fail(message: string): never {
  throw new RevokeAllowanceVerificationError(message);
}

export function verifyRevokeAllowanceTransaction(
  xdr: string,
  networkPassphrase: string,
  expected: RevokeAllowanceExpectation
): void {
  const intent = intentFromXdr(xdr, networkPassphrase);
  if (intent.source !== expected.owner) {
    fail("This transaction is not sourced from the account being revoked for.");
  }
  if (intent.memo !== null) {
    fail("This transaction carries a memo, which a revocation never needs.");
  }
  if (BigInt(intent.fee) > MAX_REVOKE_FEE_STROOPS) {
    fail("This transaction's fee is higher than a revocation should ever need.");
  }
  if (intent.operations.length !== 1) {
    fail(
      `This transaction has ${intent.operations.length} operations; a revocation has exactly one.`
    );
  }
  const op = intent.operations[0]!;
  if (op.source !== expected.owner) {
    fail("The operation does not act as the account being revoked for.");
  }
  if (op.type !== "invoke_host_function") {
    fail("This transaction does not invoke a contract.");
  }
  if (op.contract !== expected.token) {
    fail("This transaction does not touch the expected token contract.");
  }
  if (op.function !== "approve") {
    fail("This transaction does not call approve, so it is not a revocation.");
  }
  if (
    op.args.length !== 4 ||
    op.args[0] !== expected.owner ||
    op.args[1] !== expected.spender ||
    op.args[2] !== "0"
  ) {
    fail("This transaction does not revoke the expected spender's allowance on this token.");
  }
  if (op.authorizesBeyondSelf) {
    fail("This transaction authorizes more than the account's own revocation.");
  }
  if (op.authDepth !== 0) {
    fail("This transaction authorizes a nested call, which a plain revocation never needs.");
  }
  if (op.unsupportedAddressCount > 0) {
    fail("This transaction references an address form that cannot be verified.");
  }
  // The spender can legitimately be either kind of address (see the `spender` field's own
  // comment in packages/types/src/allowance.ts) - describeInvocation buckets a G... address into
  // accountsReferenced and a C... address into contractsReferenced, so it is allowed in both
  // checks below; only one of the two will ever actually contain it for a given spender.
  if (op.accountsReferenced.some((a) => a !== expected.owner && a !== expected.spender)) {
    fail("This transaction references an account other than the one being revoked for.");
  }
  if (op.contractsReferenced.some((c) => c !== expected.token && c !== expected.spender)) {
    fail("This transaction references a contract other than the token or the spender.");
  }
}
