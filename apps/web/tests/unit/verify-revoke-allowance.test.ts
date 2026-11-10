import { test, expect } from "bun:test";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES,
  RevokeAllowanceVerificationError,
  verifyRevokeAllowanceTransaction,
  type RevokeAllowanceVerificationErrorCode,
} from "@/lib/stellar/verify-revoke-allowance";

const OWNER_KP = Keypair.random();
const OWNER = OWNER_KP.publicKey();
const TOKEN = Address.contract(new Uint8Array(32).fill(1)).toString();
const SPENDER = Address.contract(new Uint8Array(32).fill(2)).toString();
const OTHER_CONTRACT = Address.contract(new Uint8Array(32).fill(9)).toString();
const OTHER_ACCOUNT = Keypair.random().publicKey();

interface AuthShape {
  nested?: boolean;
  addressCredentials?: boolean;
  otherFunction?: string;
  otherContract?: string;
}

function authEntry(
  contract: string,
  args: xdr.ScVal[],
  shape: AuthShape = {}
): xdr.SorobanAuthorizationEntry {
  const fn = (c: string, name: string, a: xdr.ScVal[]): xdr.SorobanAuthorizedFunction =>
    xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(c).toScAddress(),
        functionName: name,
        args: a,
      })
    );
  const credentials = shape.addressCredentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(OWNER).toScAddress(),
          nonce: BigInt(1),
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: fn(shape.otherContract ?? contract, shape.otherFunction ?? "approve", args),
      subInvocations: shape.nested
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: fn(OTHER_CONTRACT, "approve", []),
              subInvocations: [],
            }),
          ]
        : [],
    }),
  });
}

function approveArgs(
  over: { owner?: string; spender?: string; amount?: bigint } = {}
): xdr.ScVal[] {
  return [
    new Address(over.owner ?? OWNER).toScVal(),
    new Address(over.spender ?? SPENDER).toScVal(),
    nativeToScVal(over.amount ?? BigInt(0), { type: "i128" }),
    nativeToScVal(0, { type: "u32" }),
  ];
}

function buildRevokeXdr(
  options: {
    args?: xdr.ScVal[];
    auth?: AuthShape;
    contract?: string;
    functionName?: string;
    txSource?: string;
    opSource?: string;
    memo?: Memo;
    extraOp?: boolean;
    payment?: boolean;
    fee?: string;
    timeout?: number;
  } = {}
): string {
  const args = options.args ?? approveArgs();
  const contract = options.contract ?? TOKEN;
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: options.functionName ?? "approve",
      args,
    })
  );
  const op = options.payment
    ? Operation.payment({ destination: OTHER_ACCOUNT, asset: Asset.native(), amount: "1" })
    : Operation.invokeHostFunction({
        func: hostFunction,
        auth: [authEntry(contract, args, options.auth ?? {})],
        ...(options.opSource ? { source: options.opSource } : {}),
      });
  const raw = new TransactionBuilder(new Account(options.txSource ?? OWNER, "100"), {
    fee: options.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
  });
  raw.addOperation(op);
  if (options.extraOp) raw.addOperation(op);
  raw.setTimeout(options.timeout ?? 30);
  const envelope = raw.build().toEnvelope();
  // The SDK refuses to build this, so it goes in by hand: a hostile API can still send it.
  if (options.memo && "v1" in envelope) {
    (envelope.v1.tx as { memo: xdr.Memo }).memo = options.memo.toXDRObject();
  }
  return envelope.toXdr("base64");
}

function expectation(over: Partial<{ owner: string; token: string; spender: string }> = {}) {
  return { owner: OWNER, token: TOKEN, spender: SPENDER, ...over };
}

/** A muxed account as a contract argument: an address form the anchor cannot pin to anything. */
function muxedArg(): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({
        id: xdr.Uint64.fromString("7"),
        ed25519: OWNER_KP.rawPublicKey(),
      })
    )
  );
}

const seen = new Set<RevokeAllowanceVerificationErrorCode>();

/** Runs the anchor and returns what it threw, asserting it is a coded revocation refusal. */
function refusal(
  xdrBase64: string,
  over: Parameters<typeof expectation>[0] = {},
  now?: number
): RevokeAllowanceVerificationError {
  let thrown: unknown = null;
  try {
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation(over), now);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RevokeAllowanceVerificationError);
  const error = thrown as RevokeAllowanceVerificationError;
  expect(error.name).toBe("RevokeAllowanceVerificationError");
  seen.add(error.code);
  return error;
}

function expectRefusal(
  error: RevokeAllowanceVerificationError,
  code: RevokeAllowanceVerificationErrorCode,
  message: string
): void {
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

test("verifyRevokeAllowanceTransaction › accepts a plain, well-formed revocation", () => {
  const xdrBase64 = buildRevokeXdr();
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).not.toThrow();
});

test("verifyRevokeAllowanceTransaction › rejects a transaction sourced from a different account", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ txSource: OTHER_ACCOUNT })),
    "revoke_transaction_source_mismatch",
    "This transaction is not sourced from the account being revoked for."
  );
});

test("verifyRevokeAllowanceTransaction › rejects an operation acting as another account", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ opSource: OTHER_ACCOUNT })),
    "revoke_operation_source_mismatch",
    "The operation does not act as the account being revoked for."
  );
});

test("verifyRevokeAllowanceTransaction › rejects an operation that invokes no contract", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ payment: true })),
    "revoke_not_invocation",
    "This transaction does not invoke a contract."
  );
});

test("verifyRevokeAllowanceTransaction › rejects a call to a function other than approve", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ functionName: "transfer" })),
    "revoke_function_not_approve",
    "This transaction does not call approve, so it is not a revocation."
  );
});

const ARGS_MISMATCH =
  "This transaction does not revoke the expected spender's allowance on this token.";

test("verifyRevokeAllowanceTransaction › rejects a non-zero amount - that is a grant, not a revocation", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ args: approveArgs({ amount: BigInt(5) }) })),
    "revoke_approve_args_mismatch",
    ARGS_MISMATCH
  );
});

test("verifyRevokeAllowanceTransaction › rejects a spender other than the one being revoked", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ args: approveArgs({ spender: OTHER_CONTRACT }) })),
    "revoke_approve_args_mismatch",
    ARGS_MISMATCH
  );
});

test("verifyRevokeAllowanceTransaction › rejects an approve call with the wrong argument count", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ args: approveArgs().slice(0, 3) })),
    "revoke_approve_args_mismatch",
    ARGS_MISMATCH
  );
});

test("verifyRevokeAllowanceTransaction › rejects a call against a different token contract", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ contract: OTHER_CONTRACT })),
    "revoke_token_mismatch",
    "This transaction does not touch the expected token contract."
  );
});

test("verifyRevokeAllowanceTransaction › rejects an authorization entry that authorizes a nested call", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ auth: { nested: true } })),
    "revoke_auth_nested",
    "This transaction authorizes a nested call, which a plain revocation never needs."
  );
});

test("verifyRevokeAllowanceTransaction › rejects an authorization entry under another party's credentials", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ auth: { addressCredentials: true } })),
    "revoke_auth_beyond_self",
    "This transaction authorizes more than the account's own revocation."
  );
});

test("verifyRevokeAllowanceTransaction › rejects an address form that cannot be verified", () => {
  const args = [...approveArgs().slice(0, 3), muxedArg()];
  expectRefusal(
    refusal(buildRevokeXdr({ args })),
    "revoke_address_unsupported",
    "This transaction references an address form that cannot be verified."
  );
});

test("verifyRevokeAllowanceTransaction › rejects a reference to an account other than the owner or spender", () => {
  const args = [...approveArgs().slice(0, 3), new Address(OTHER_ACCOUNT).toScVal()];
  expectRefusal(
    refusal(buildRevokeXdr({ args })),
    "revoke_foreign_account",
    "This transaction references an account other than the one being revoked for."
  );
});

test("verifyRevokeAllowanceTransaction › rejects a reference to a contract other than the token or spender", () => {
  const args = [...approveArgs().slice(0, 3), new Address(OTHER_CONTRACT).toScVal()];
  expectRefusal(
    refusal(buildRevokeXdr({ args })),
    "revoke_foreign_contract",
    "This transaction references a contract other than the token or the spender."
  );
});

test("verifyRevokeAllowanceTransaction › rejects a transaction carrying a memo - a revocation never needs one", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ memo: Memo.text("hi") })),
    "revoke_memo_present",
    "This transaction carries a memo, which a revocation never needs."
  );
});

test("verifyRevokeAllowanceTransaction › rejects more than one operation", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ extraOp: true })),
    "revoke_operation_count",
    "This transaction has 2 operations; a revocation has exactly one."
  );
});

test("verifyRevokeAllowanceTransaction › accepts a plain account as the spender, not just a contract", () => {
  // SEP-41's approve(from, spender, ...) types spender as Address - a G... account is legitimate,
  // if unusual (packages/types/src/allowance.ts's own doc comment on Allowance.spender).
  const accountSpender = Keypair.random().publicKey();
  const xdrBase64 = buildRevokeXdr({ args: approveArgs({ spender: accountSpender }) });
  expect(() =>
    verifyRevokeAllowanceTransaction(
      xdrBase64,
      Networks.TESTNET,
      expectation({ spender: accountSpender })
    )
  ).not.toThrow();
});

test("verifyRevokeAllowanceTransaction › rejects a fee higher than a revocation should ever need", () => {
  expectRefusal(
    refusal(buildRevokeXdr({ fee: "20000000" })),
    "revoke_fee_above_cap",
    "This transaction's fee is higher than a revocation should ever need."
  );
});

test("verifyRevokeAllowanceTransaction › rejects a revocation that never expires or stays valid past fifteen minutes", () => {
  const now = Math.floor(Date.now() / 1000) + 1;
  expectRefusal(
    refusal(buildRevokeXdr({ timeout: 0 }), {}, now),
    "revoke_expiry_missing",
    "This transaction never expires, so it could be submitted long after you approved it."
  );
  expectRefusal(
    refusal(buildRevokeXdr({ timeout: 3600 }), {}, now),
    "revoke_expiry_too_far",
    "This transaction stays valid for far longer than a revocation needs."
  );
  expect(() =>
    verifyRevokeAllowanceTransaction(
      buildRevokeXdr({ timeout: 300 }),
      Networks.TESTNET,
      expectation(),
      now
    )
  ).not.toThrow();
});

// Declared last: bun runs a file's tests in order, so every refusal above has been recorded.
test("verifyRevokeAllowanceTransaction › every refusal code is produced by a test above", () => {
  expect([...seen].sort()).toEqual([...REVOKE_ALLOWANCE_VERIFICATION_ERROR_CODES].sort());
});
