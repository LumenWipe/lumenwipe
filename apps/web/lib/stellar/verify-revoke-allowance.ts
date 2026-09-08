import { intentFromXdr } from "./intent/serialize";

/**
 * The trust anchor for one allowance revocation (#163, architecture.md §12) - independent of the
 * account-close flow, so it does not go through `verify()`/`assertCloseIntent`'s close-shaped
 * allowlist. Every expected value comes from what the user already sees in the inspector table
 * (owner, token, spender), never from the API response, matching the close flow's own rule
 * (`docs/architecture.md` §13.1): a compromised or buggy API must never get anything signed that
 * does more than revoke exactly the allowance the user clicked "Revoke" on.
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
  if (op.accountsReferenced.some((a) => a !== expected.owner)) {
    fail("This transaction references an account other than the one being revoked for.");
  }
  if (op.contractsReferenced.some((c) => c !== expected.token && c !== expected.spender)) {
    fail("This transaction references a contract other than the token or the spender.");
  }
}
