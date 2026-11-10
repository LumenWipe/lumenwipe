/**
 * Builds `vectors/revoke-allowance-v1.json`, the conformance vector set for
 * `verifyRevokeAllowanceTransaction`. `generate-vectors.ts` writes it next to `close-v1.json`, and
 * its `--check` compares both.
 *
 * Every transaction is built here from fixed inputs, so the output is byte-for-byte stable. Keys
 * and contract ids come from fixed seeds and only their public halves are ever written; the file
 * holds no secret. Every rejection is one named mutation of an accepted vector's transaction, and
 * its expected class, code and message are written by hand below, never captured from a run of
 * the verifier.
 */
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Asset,
  hash,
  Keypair,
  Memo,
  Networks,
  nativeToScVal,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  RevokeAllowanceExpectation,
  RevokeAllowanceVerificationErrorCode,
  VerificationErrorCode,
} from "../src/index";

export const REVOKE_VECTORS_PATH = fileURLToPath(
  new URL("../vectors/revoke-allowance-v1.json", import.meta.url)
);

/** The clock every vector is verified at: 2026-11-01T00:00:00Z. */
const NOW = 1_793_491_200;

const seed = (label: string): Buffer =>
  Buffer.from(hash(Buffer.from(`lumenwipe revoke-allowance-v1 ${label}`)));

/** A public key from a fixed seed. Only the public key is returned, so no secret reaches the file. */
const account = (label: string): Keypair => Keypair.fromRawEd25519Seed(seed(label));
const contract = (label: string): string => StrKey.encodeContract(seed(label));

const OWNER_KEY = account("owner");
const OWNER = OWNER_KEY.publicKey();
const OTHER_ACCOUNT = account("other account").publicKey();
const ACCOUNT_SPENDER = account("account spender").publicKey();
const TOKEN = contract("token");
const SPENDER = contract("spender");
const OTHER_CONTRACT = contract("other contract");

export interface RevokeVectorInput {
  /** The unsigned transaction envelope, base64. */
  unsignedXdr: string;
  /** The network passphrase the envelope is decoded with. */
  networkPassphrase: string;
  /** What the screen showed the user before they clicked "Revoke". */
  expected: RevokeAllowanceExpectation;
}

interface RevokeAcceptVector {
  name: string;
  verdict: "accept";
  description: string;
  nowSeconds: number;
  input: RevokeVectorInput;
}

export type RevokeVectorError =
  | {
      class: "RevokeAllowanceVerificationError";
      code: RevokeAllowanceVerificationErrorCode;
      message: string;
    }
  | { class: "VerificationError"; code: VerificationErrorCode; message: string };

interface RevokeRejectVector {
  name: string;
  verdict: "reject";
  base: string;
  mutation: string;
  nowSeconds: number;
  input: RevokeVectorInput;
  error: RevokeVectorError;
}

export type RevokeVector = RevokeAcceptVector | RevokeRejectVector;

export interface RevokeVectorFile {
  schema: 1;
  name: "revoke-allowance-v1";
  description: string;
  generator: string;
  vectors: RevokeVector[];
}

interface AuthShape {
  /** Address credentials for the owner instead of the source account's own. */
  addressCredentials?: boolean;
  /** A nested call under the authorized `approve`. */
  nested?: boolean;
}

function authorizedCall(contractId: string, name: string, args: xdr.ScVal[]) {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: name,
      args,
    })
  );
}

function authEntry(
  contractId: string,
  name: string,
  args: xdr.ScVal[],
  shape: AuthShape
): xdr.SorobanAuthorizationEntry {
  const credentials = shape.addressCredentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(OWNER).toScAddress(),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: authorizedCall(contractId, name, args),
      subInvocations: shape.nested
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: authorizedCall(OTHER_CONTRACT, "approve", []),
              subInvocations: [],
            }),
          ]
        : [],
    }),
  });
}

/** `approve(owner, spender, 0, 0)`: the revocation the screen describes. */
function approveArgs(spender = SPENDER, amount = BigInt(0)): xdr.ScVal[] {
  return [
    new Address(OWNER).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(0, { type: "u32" }),
  ];
}

/** A muxed account: an address form the verifier cannot pin to anything. */
const MUXED_ARG = xdr.ScVal.scvAddress(
  xdr.ScAddress.scAddressTypeMuxedAccount(
    new xdr.MuxedEd25519Account({
      id: xdr.Uint64.fromString("7"),
      ed25519: OWNER_KEY.rawPublicKey(),
    })
  )
);

interface BuildOptions {
  args?: xdr.ScVal[];
  contract?: string;
  functionName?: string;
  auth?: AuthShape;
  txSource?: string;
  opSource?: string;
  /** Per-operation base fee in stroops. */
  fee?: number;
  maxTime?: number;
  operationCount?: number;
  /** A classic payment in place of the contract call. */
  payment?: boolean;
  /** Set on the envelope by hand: the SDK refuses to build a memo on a Soroban transaction. */
  memo?: xdr.Memo;
}

function build(options: BuildOptions = {}): string {
  const args = options.args ?? approveArgs();
  const contractId = options.contract ?? TOKEN;
  const functionName = options.functionName ?? "approve";
  const operation = options.payment
    ? Operation.payment({ destination: OTHER_ACCOUNT, asset: Asset.native(), amount: "1" })
    : Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contractId).toScAddress(),
            functionName,
            args,
          })
        ),
        auth: [authEntry(contractId, functionName, args, options.auth ?? {})],
        ...(options.opSource ? { source: options.opSource } : {}),
      });
  const builder = new TransactionBuilder(new Account(options.txSource ?? OWNER, "4294967296"), {
    fee: String(options.fee ?? 100),
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: options.maxTime ?? NOW + 300 },
  });
  for (let i = 0; i < (options.operationCount ?? 1); i += 1) builder.addOperation(operation);
  const envelope = builder.build().toEnvelope();
  if (options.memo) {
    if (envelope.type !== "envelopeTypeTx") throw new Error("not a v1 envelope");
    (envelope.v1.tx as { memo: xdr.Memo }).memo = options.memo;
  }
  return envelope.toXdr("base64");
}

const expectation = (spender = SPENDER): RevokeAllowanceExpectation => ({
  owner: OWNER,
  token: TOKEN,
  spender,
});

const accepts: RevokeAcceptVector[] = [];
const rejects: RevokeRejectVector[] = [];

function accept(
  name: string,
  description: string,
  unsignedXdr: string,
  expected: RevokeAllowanceExpectation
): RevokeAcceptVector {
  const vector: RevokeAcceptVector = {
    name,
    verdict: "accept",
    description,
    nowSeconds: NOW,
    input: { unsignedXdr, networkPassphrase: Networks.TESTNET, expected },
  };
  accepts.push(vector);
  return vector;
}

function reject(
  base: RevokeAcceptVector,
  name: string,
  mutation: string,
  unsignedXdr: string,
  error: RevokeVectorError
): void {
  rejects.push({
    name,
    verdict: "reject",
    base: base.name,
    mutation,
    nowSeconds: base.nowSeconds,
    input: { ...base.input, unsignedXdr },
    error,
  });
}

const refuse = (
  code: RevokeAllowanceVerificationErrorCode,
  message: string
): RevokeVectorError => ({ class: "RevokeAllowanceVerificationError", code, message });

const ARGS_MISMATCH =
  "This transaction does not revoke the expected spender's allowance on this token.";

// --- Accepted ------------------------------------------------------------------------------

const revoke = accept(
  "revoke-contract-spender",
  "approve(owner, spender, 0, 0) on the token, sourced from the owner, valid for five minutes, with the owner's own source-account authorization and no memo. The spender is a contract.",
  build(),
  expectation()
);

accept(
  "revoke-account-spender",
  "The same revocation for a spender that is a plain account rather than a contract.",
  build({ args: approveArgs(ACCOUNT_SPENDER) }),
  expectation(ACCOUNT_SPENDER)
);

// --- Rejected, in the order the verifier checks ------------------------------------------

reject(
  revoke,
  "never-expires",
  "Sets maxTime to 0: no upper time bound.",
  build({ maxTime: 0 }),
  refuse(
    "revoke_expiry_missing",
    "This transaction never expires, so it could be submitted long after you approved it."
  )
);
reject(
  revoke,
  "valid-past-fifteen-minutes",
  "Sets maxTime to one hour after nowSeconds, past the 900-second window.",
  build({ maxTime: NOW + 3600 }),
  refuse(
    "revoke_expiry_too_far",
    "This transaction stays valid for far longer than a revocation needs."
  )
);
reject(
  revoke,
  "transaction-source-not-owner",
  "Sources the transaction from another account.",
  build({ txSource: OTHER_ACCOUNT }),
  refuse(
    "revoke_transaction_source_mismatch",
    "This transaction is not sourced from the account being revoked for."
  )
);
reject(
  revoke,
  "carries-memo",
  'Adds the text memo "hi".',
  build({ memo: Memo.text("hi").toXDRObject() }),
  refuse("revoke_memo_present", "This transaction carries a memo, which a revocation never needs.")
);
reject(
  revoke,
  "memo-not-valid-text",
  "Adds a text memo whose bytes are not valid UTF-8, which the decoder refuses before any revocation check.",
  build({ memo: xdr.Memo.memoText(Buffer.from([0xff, 0xfe])) }),
  {
    class: "VerificationError",
    code: "memo_invalid_text",
    message: "The transaction carries a memo that is not valid text.",
  }
);
reject(
  revoke,
  "fee-above-cap",
  "Raises the fee to 10,000,001 stroops, one above the 1 XLM cap.",
  build({ fee: 10_000_001 }),
  refuse(
    "revoke_fee_above_cap",
    "This transaction's fee is higher than a revocation should ever need."
  )
);
reject(
  revoke,
  "two-operations",
  "Repeats the approve call as a second operation.",
  build({ operationCount: 2 }),
  refuse(
    "revoke_operation_count",
    "This transaction has 2 operations; a revocation has exactly one."
  )
);
reject(
  revoke,
  "operation-source-not-owner",
  "Gives the operation another account as its source.",
  build({ opSource: OTHER_ACCOUNT }),
  refuse(
    "revoke_operation_source_mismatch",
    "The operation does not act as the account being revoked for."
  )
);
reject(
  revoke,
  "not-a-contract-call",
  "Replaces the contract call with a 1 XLM payment to another account.",
  build({ payment: true }),
  refuse("revoke_not_invocation", "This transaction does not invoke a contract.")
);
reject(
  revoke,
  "other-token",
  "Calls approve on another contract instead of the token.",
  build({ contract: OTHER_CONTRACT }),
  refuse("revoke_token_mismatch", "This transaction does not touch the expected token contract.")
);
reject(
  revoke,
  "calls-transfer",
  "Calls transfer instead of approve, with the same arguments.",
  build({ functionName: "transfer" }),
  refuse(
    "revoke_function_not_approve",
    "This transaction does not call approve, so it is not a revocation."
  )
);
reject(
  revoke,
  "non-zero-amount",
  "Approves 5 instead of 0: a grant, not a revocation.",
  build({ args: approveArgs(SPENDER, BigInt(5)) }),
  refuse("revoke_approve_args_mismatch", ARGS_MISMATCH)
);
reject(
  revoke,
  "other-spender",
  "Revokes another contract's allowance instead of the spender's.",
  build({ args: approveArgs(OTHER_CONTRACT) }),
  refuse("revoke_approve_args_mismatch", ARGS_MISMATCH)
);
reject(
  revoke,
  "three-arguments",
  "Drops approve's expiration ledger argument.",
  build({ args: approveArgs().slice(0, 3) }),
  refuse("revoke_approve_args_mismatch", ARGS_MISMATCH)
);
reject(
  revoke,
  "address-credentials",
  "Authorizes the call under address credentials instead of the source account's own.",
  build({ auth: { addressCredentials: true } }),
  refuse(
    "revoke_auth_beyond_self",
    "This transaction authorizes more than the account's own revocation."
  )
);
reject(
  revoke,
  "nested-authorization",
  "Adds a nested approve on another contract under the authorized call.",
  build({ auth: { nested: true } }),
  refuse(
    "revoke_auth_nested",
    "This transaction authorizes a nested call, which a plain revocation never needs."
  )
);
reject(
  revoke,
  "muxed-address-argument",
  "Replaces the expiration ledger argument with a muxed account.",
  build({ args: [...approveArgs().slice(0, 3), MUXED_ARG] }),
  refuse(
    "revoke_address_unsupported",
    "This transaction references an address form that cannot be verified."
  )
);
reject(
  revoke,
  "foreign-account-argument",
  "Replaces the expiration ledger argument with another account.",
  build({ args: [...approveArgs().slice(0, 3), new Address(OTHER_ACCOUNT).toScVal()] }),
  refuse(
    "revoke_foreign_account",
    "This transaction references an account other than the one being revoked for."
  )
);
reject(
  revoke,
  "foreign-contract-argument",
  "Replaces the expiration ledger argument with another contract.",
  build({ args: [...approveArgs().slice(0, 3), new Address(OTHER_CONTRACT).toScVal()] }),
  refuse(
    "revoke_foreign_contract",
    "This transaction references a contract other than the token or the spender."
  )
);

export function buildRevokeVectorFile(): RevokeVectorFile {
  return {
    schema: 1,
    name: "revoke-allowance-v1",
    description:
      "Conformance vectors for verifyRevokeAllowanceTransaction. Call the verifier with input.unsignedXdr, input.networkPassphrase, input.expected and nowSeconds, and expect it to return (accept) or to throw an error of exactly error.class with exactly error.code and error.message (reject). A RevokeAllowanceVerificationError is a revocation check; a VerificationError is a transaction the decoder refused first. The code is the stable reason to branch on; the message is the current English wording. Each reject is one named mutation of the transaction of the accept named in base. Every key is public.",
    generator: "packages/verify/scripts/revoke-vectors.ts",
    vectors: [...accepts, ...rejects],
  };
}
