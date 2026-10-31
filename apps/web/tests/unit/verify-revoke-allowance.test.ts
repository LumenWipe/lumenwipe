import { test, expect } from "bun:test";
import {
  Account,
  Address,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  RevokeAllowanceVerificationError,
  verifyRevokeAllowanceTransaction,
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
    txSource?: string;
    memo?: Memo;
    extraOp?: boolean;
    fee?: string;
    timeout?: number;
  } = {}
): string {
  const args = options.args ?? approveArgs();
  const contract = options.contract ?? TOKEN;
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: "approve",
      args,
    })
  );
  const op = Operation.invokeHostFunction({
    func: hostFunction,
    auth: [authEntry(contract, args, options.auth ?? {})],
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

test("verifyRevokeAllowanceTransaction › accepts a plain, well-formed revocation", () => {
  const xdrBase64 = buildRevokeXdr();
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).not.toThrow();
});

test("verifyRevokeAllowanceTransaction › rejects a transaction sourced from a different account", () => {
  const xdrBase64 = buildRevokeXdr({ txSource: OTHER_ACCOUNT });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(RevokeAllowanceVerificationError);
});

test("verifyRevokeAllowanceTransaction › rejects a non-zero amount - that is a grant, not a revocation", () => {
  const xdrBase64 = buildRevokeXdr({ args: approveArgs({ amount: BigInt(5) }) });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/revoke the expected spender/);
});

test("verifyRevokeAllowanceTransaction › rejects a spender other than the one being revoked", () => {
  const xdrBase64 = buildRevokeXdr({ args: approveArgs({ spender: OTHER_CONTRACT }) });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/revoke the expected spender/);
});

test("verifyRevokeAllowanceTransaction › rejects a call against a different token contract", () => {
  const xdrBase64 = buildRevokeXdr({ contract: OTHER_CONTRACT });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/expected token contract/);
});

test("verifyRevokeAllowanceTransaction › rejects an authorization entry that authorizes a nested call", () => {
  const xdrBase64 = buildRevokeXdr({ auth: { nested: true } });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/nested call/);
});

test("verifyRevokeAllowanceTransaction › rejects an authorization entry under another party's credentials", () => {
  const xdrBase64 = buildRevokeXdr({ auth: { addressCredentials: true } });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/more than the account's own/);
});

test("verifyRevokeAllowanceTransaction › rejects a transaction carrying a memo - a revocation never needs one", () => {
  const xdrBase64 = buildRevokeXdr({ memo: Memo.text("hi") });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/carries a memo/);
});

test("verifyRevokeAllowanceTransaction › rejects more than one operation", () => {
  const xdrBase64 = buildRevokeXdr({ extraOp: true });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/exactly one/);
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
  const xdrBase64 = buildRevokeXdr({ fee: "20000000" });
  expect(() =>
    verifyRevokeAllowanceTransaction(xdrBase64, Networks.TESTNET, expectation())
  ).toThrow(/fee is higher/);
});

test("verifyRevokeAllowanceTransaction › rejects a revocation that never expires or stays valid past fifteen minutes", () => {
  const run = (timeout: number, now: number) =>
    verifyRevokeAllowanceTransaction(
      buildRevokeXdr({ timeout }),
      Networks.TESTNET,
      expectation(),
      now
    );
  const now = Math.floor(Date.now() / 1000) + 1;
  expect(() => run(0, now)).toThrow(/never expires/);
  expect(() => run(3600, now)).toThrow(/far longer/);
  expect(() => run(300, now)).not.toThrow();
});
