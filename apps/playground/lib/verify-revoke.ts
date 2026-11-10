import "server-only";
import { Address, scValToNative, type Transaction, type xdr } from "@stellar/stellar-sdk";
import { XLM_SAC } from "./scenarios";
import { MAX_SOROBAN_FEE_STROOPS } from "./soroban-submit";

// The playground's own check of an allowance revoke the API built, run before the shared revoke
// anchor (`verifyRevokeAllowanceTransaction` from `@lumenwipe/verify`, lib/allowances.ts). Both
// must pass before the demo key signs. Everything it compares against comes from the playground's
// configuration (the pinned XLM asset contract) and the session record (the demo and the spenders
// it recorded before each approve was sent), never from the API's response or its allowance list:
//
// - one operation, an `invokeHostFunction` calling a contract function, with the demo as the
//   transaction's and the operation's source;
// - the contract is the pinned XLM asset contract, the only token the scenario approves on;
// - the function is `approve` with exactly four arguments: the demo as `from`, a spender the
//   session recorded, an i128 amount of zero, and a u32 expiration ledger;
// - every authorization entry is satisfied by the transaction's own signature (source-account
//   credentials), is rooted at that same call and authorizes no sub-invocation;
// - the fee is at most `MAX_SOROBAN_FEE_STROOPS`, and the transaction expires no later than
//   `MAX_REVOKE_VALIDITY_SECONDS` from now.

export class RevokeVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RevokeVerificationError";
  }
}

/** The longest a revoke may stay valid: the shared anchor's bound, restated. The API sets 300. */
export const MAX_REVOKE_VALIDITY_SECONDS = 900;

/** What a revoke may do, from the session record only. */
export interface RevokeExpectation {
  demoPublic: string;
  /** Every spender the session recorded an allowance for. */
  spenders: readonly string[];
}

const addressOf = (val: xdr.ScVal | undefined): string | null =>
  val?.type === "scvAddress" ? Address.fromScAddress(val.address).toString() : null;

const fail = (code: string): never => {
  throw new RevokeVerificationError(code);
};

/** Throws a RevokeVerificationError unless `tx` revokes a recorded allowance and nothing else. */
export function assertRevokeTransaction(
  tx: Transaction,
  expected: RevokeExpectation,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  if (tx.source !== expected.demoPublic) fail("revoke_source_mismatch");
  if (tx.operations.length !== 1) fail("revoke_not_one_operation");
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") return fail("revoke_not_contract_call");
  if ((op.source ?? tx.source) !== expected.demoPublic) fail("revoke_source_mismatch");
  if (op.func.type !== "hostFunctionTypeInvokeContract") return fail("revoke_not_contract_call");
  const call = op.func.invokeContract;
  if (Address.fromScAddress(call.contractAddress).toString() !== XLM_SAC) {
    fail("revoke_contract_not_pinned");
  }
  if (call.functionName.toString() !== "approve") fail("revoke_function_not_approve");
  const args = call.args;
  if (args.length !== 4) fail("revoke_arguments_invalid");
  if (addressOf(args[0]) !== expected.demoPublic) fail("revoke_from_not_demo");
  const spender = addressOf(args[1]);
  if (spender === null || !expected.spenders.includes(spender)) {
    fail("revoke_spender_not_recorded");
  }
  const amount = args[2];
  if (amount?.type !== "scvI128" || scValToNative(amount) !== BigInt(0)) {
    fail("revoke_amount_not_zero");
  }
  if (args[3]?.type !== "scvU32") fail("revoke_arguments_invalid");

  const root = call.toXdr("base64");
  for (const entry of op.auth ?? []) {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      fail("revoke_auth_credentials_not_source");
    }
    const fn = entry.rootInvocation.function;
    if (
      fn.type !== "sorobanAuthorizedFunctionTypeContractFn" ||
      fn.contractFn.toXdr("base64") !== root
    ) {
      fail("revoke_auth_root_not_the_call");
    }
    if (entry.rootInvocation.subInvocations.length > 0) fail("revoke_auth_sub_invocation");
  }

  if (BigInt(tx.fee) > MAX_SOROBAN_FEE_STROOPS) fail("revoke_fee_above_cap");
  const maxTime = Number(tx.timeBounds?.maxTime ?? "0");
  if (!Number.isInteger(maxTime) || maxTime <= 0) fail("revoke_expiry_missing");
  if (maxTime > nowSeconds + MAX_REVOKE_VALIDITY_SECONDS) fail("revoke_expiry_too_far");
}
