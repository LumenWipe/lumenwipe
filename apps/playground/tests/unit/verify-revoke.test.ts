import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  RevokeAllowanceVerificationError,
  verifyRevokeAllowanceTransaction,
} from "@lumenwipe/verify";
import {
  assertRevokeTransaction,
  MAX_REVOKE_VALIDITY_SECONDS,
  RevokeVerificationError,
} from "@/lib/verify-revoke";
import { PINNED_ASSETS, XLM_SAC } from "@/lib/scenarios";
import { address, approveArgs, revokeTx, rootedAt, withMemo } from "./revoke-fixtures";

// The playground's own check of an allowance revoke (lib/verify-revoke.ts): each rule refuses the
// transaction that breaks it, and a revoke built the way the API builds it is accepted.

const demo = Keypair.random().publicKey();
const spender = Keypair.random().publicKey();
const otherSpender = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const RECORDED = { demoPublic: demo, spenders: [spender, otherSpender] };
const now = (): number => Math.floor(Date.now() / 1000);

function outcome(tx: Transaction, expected = RECORDED, nowSeconds = now()): string {
  try {
    assertRevokeTransaction(tx, expected, nowSeconds);
    return "accepted";
  } catch (err) {
    if (err instanceof RevokeVerificationError) return err.code;
    throw err;
  }
}

const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

describe("assertRevokeTransaction", () => {
  test("approve(demo, a recorded spender, 0, 0) on XLM's asset contract is accepted", () => {
    expect(outcome(revokeTx({ owner: demo, spender }))).toBe("accepted");
    expect(outcome(revokeTx({ owner: demo, spender: otherSpender }))).toBe("accepted");
  });

  test("a non-zero amount is refused, as is an amount of another integer type", () => {
    expect(outcome(revokeTx({ owner: demo, spender, amount: i128(BigInt(1)) }))).toBe(
      "revoke_amount_not_zero"
    );
    const u32Zero = xdr.ScVal.scvU32(0);
    expect(outcome(revokeTx({ owner: demo, spender, amount: u32Zero }))).toBe(
      "revoke_amount_not_zero"
    );
  });

  test("a spender the session did not record is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender: stranger }))).toBe(
      "revoke_spender_not_recorded"
    );
    const contractSpender = StrKey.encodeContract(randomBytes(32));
    expect(outcome(revokeTx({ owner: demo, spender: contractSpender }))).toBe(
      "revoke_spender_not_recorded"
    );
  });

  test("a contract other than the pinned XLM asset contract is refused", () => {
    expect(
      outcome(revokeTx({ owner: demo, spender, contract: PINNED_ASSETS["circle-usdc"].contract }))
    ).toBe("revoke_contract_not_pinned");
    const unknown = StrKey.encodeContract(randomBytes(32));
    expect(outcome(revokeTx({ owner: demo, spender, contract: unknown }))).toBe(
      "revoke_contract_not_pinned"
    );
  });

  test("a `from` other than the demo is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender, from: stranger }))).toBe(
      "revoke_from_not_demo"
    );
  });

  test("a transaction or an operation not sourced from the demo is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender, source: stranger }))).toBe(
      "revoke_source_mismatch"
    );
    expect(outcome(revokeTx({ owner: demo, spender, opSource: stranger }))).toBe(
      "revoke_source_mismatch"
    );
  });

  test("a function other than approve, or another arity, is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender, fn: "transfer" }))).toBe(
      "revoke_function_not_approve"
    );
    const three = approveArgs(demo, spender).slice(0, 3);
    expect(outcome(revokeTx({ owner: demo, spender, args: three }))).toBe(
      "revoke_arguments_invalid"
    );
    const five = [...approveArgs(demo, spender), xdr.ScVal.scvU32(1)];
    expect(outcome(revokeTx({ owner: demo, spender, args: five }))).toBe(
      "revoke_arguments_invalid"
    );
    const ledgerAsI128 = [...approveArgs(demo, spender).slice(0, 3), i128(BigInt(0))];
    expect(outcome(revokeTx({ owner: demo, spender, args: ledgerAsI128 }))).toBe(
      "revoke_arguments_invalid"
    );
  });

  test("an authorization with a sub-invocation is refused", () => {
    const sub = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(XLM_SAC).toScAddress(),
          functionName: "transfer",
          args: [address(demo), address(stranger), i128(BigInt(1))],
        })
      ),
      subInvocations: [],
    });
    expect(
      outcome(revokeTx({ owner: demo, spender, auth: (call) => [rootedAt(call, [sub])] }))
    ).toBe("revoke_auth_sub_invocation");
  });

  test("address credentials are refused: only the transaction's own signature authorizes", () => {
    const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(demo).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      })
    );
    expect(
      outcome(revokeTx({ owner: demo, spender, auth: (call) => [rootedAt(call, [], credentials)] }))
    ).toBe("revoke_auth_credentials_not_source");
  });

  test("an authorization rooted at another call is refused", () => {
    const other = new xdr.InvokeContractArgs({
      contractAddress: new Address(XLM_SAC).toScAddress(),
      functionName: "approve",
      args: approveArgs(demo, spender, i128(BigInt(5))),
    });
    expect(outcome(revokeTx({ owner: demo, spender, auth: () => [rootedAt(other)] }))).toBe(
      "revoke_auth_root_not_the_call"
    );
  });

  test("a fee over the cap is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender, fee: "10000000" }))).toBe("accepted");
    expect(outcome(revokeTx({ owner: demo, spender, fee: "10000001" }))).toBe(
      "revoke_fee_above_cap"
    );
  });

  test("a transaction with no upper time bound, or one too far out, is refused", () => {
    expect(outcome(revokeTx({ owner: demo, spender, timeout: 0 }))).toBe("revoke_expiry_missing");
    expect(
      outcome(revokeTx({ owner: demo, spender, timeout: MAX_REVOKE_VALIDITY_SECONDS + 60 }))
    ).toBe("revoke_expiry_too_far");
  });

  test("a second operation is refused", () => {
    const extra = Operation.bumpSequence({ bumpTo: "0" });
    expect(outcome(revokeTx({ owner: demo, spender, extraOps: [extra] }))).toBe(
      "revoke_not_one_operation"
    );
  });
});

describe("the shared revoke anchor behind it", () => {
  const shared = (tx: Transaction, expectedSpender = spender): string => {
    try {
      verifyRevokeAllowanceTransaction(
        tx.toEnvelope().toXDR("base64"),
        Networks.TESTNET,
        { owner: demo, token: XLM_SAC, spender: expectedSpender },
        now()
      );
      return "accepted";
    } catch (err) {
      if (err instanceof RevokeAllowanceVerificationError) return err.code;
      throw err;
    }
  };

  test("accepts what the playground's check accepts for the recorded spender", () => {
    expect(shared(revokeTx({ owner: demo, spender }))).toBe("accepted");
  });

  test("with the playground's check left out, it still refuses with its own stable codes", () => {
    // Each of these gets past a check that is bypassed here, and the anchor alone refuses it.
    expect(shared(revokeTx({ owner: demo, spender, amount: i128(BigInt(1)) }))).toBe(
      "revoke_approve_args_mismatch"
    );
    expect(shared(revokeTx({ owner: demo, spender: stranger }))).toBe(
      "revoke_approve_args_mismatch"
    );
    expect(
      shared(revokeTx({ owner: demo, spender, contract: PINNED_ASSETS["circle-usdc"].contract }))
    ).toBe("revoke_token_mismatch");
    expect(shared(revokeTx({ owner: demo, spender, source: stranger }))).toBe(
      "revoke_transaction_source_mismatch"
    );
    // The other recorded spender passes the playground's membership check, but not the anchor,
    // which holds the transaction to the one allowance being revoked.
    expect(outcome(revokeTx({ owner: demo, spender: otherSpender }))).toBe("accepted");
    expect(shared(revokeTx({ owner: demo, spender: otherSpender }))).toBe(
      "revoke_approve_args_mismatch"
    );
    // A memo is nothing the playground's check looks at; the anchor refuses it.
    const memo = withMemo(revokeTx({ owner: demo, spender }), "hi");
    expect(outcome(memo)).toBe("accepted");
    expect(shared(memo)).toBe("revoke_memo_present");
  });
});
