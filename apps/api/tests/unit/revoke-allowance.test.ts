/**
 * The allowance revocation round: one plain `approve(owner, spender, 0, 0)` per request,
 * simulated, assembled, and refused by name whenever its shape is anything other than that one
 * call under the account's own credentials.
 */
import { describe, expect, test } from "bun:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  RevokeAllowanceBlockedError,
  buildRevokeAllowanceTransaction,
} from "@/lib/stellar/revoke-allowance";
import { rawSimulation } from "./fixtures/fake-exit-adapter";

const OWNER = Keypair.random().publicKey();
const TOKEN = Address.contract(Buffer.alloc(32, 1)).toString();
const SPENDER = Address.contract(Buffer.alloc(32, 2)).toString();
const OTHER = Address.contract(Buffer.alloc(32, 9)).toString();

function calledFunction(tx: Transaction): { contract: string; fn: string; args: xdr.ScVal[] } {
  const op = tx.toEnvelope().v1().tx().operations()[0]!;
  const call = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
    args: call.args(),
  };
}

interface AuthShape {
  nested?: boolean;
  addressCredentials?: boolean;
  otherFunction?: string;
  otherContract?: string;
  otherArgs?: xdr.ScVal[];
}

function authEntry(token: string, args: xdr.ScVal[], shape: AuthShape = {}): string {
  const fn = (contract: string, name: string, a: xdr.ScVal[]): xdr.SorobanAuthorizedFunction =>
    xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: name,
        args: a,
      })
    );
  const credentials = shape.addressCredentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(OWNER).toScAddress(),
          nonce: new xdr.Int64(1),
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: fn(
        shape.otherContract ?? token,
        shape.otherFunction ?? "approve",
        shape.otherArgs ?? args
      ),
      subInvocations: shape.nested
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: fn(OTHER, "approve", []),
              subInvocations: [],
            }),
          ]
        : [],
    }),
  }).toXDR("base64");
}

interface FakeOptions {
  /** How the token's `approve` simulates: the auth it asks for, or a failure. */
  approve?: { auth?: AuthShape; mode?: "ok" | "error" | "restore"; minResourceFee?: string };
  sequence?: string;
  accountMissing?: boolean;
}

function fakeRpc(options: FakeOptions = {}): {
  simulateTransaction: rpc.Server["simulateTransaction"];
  getAccount: rpc.Server["getAccount"];
} {
  return {
    async getAccount(address: string) {
      if (options.accountMissing) throw new Error(`Account not found: ${address}`);
      return new Account(address, options.sequence ?? "100") as unknown as Awaited<
        ReturnType<rpc.Server["getAccount"]>
      >;
    },
    async simulateTransaction(tx) {
      const call = calledFunction(tx as Transaction);
      if (call.fn !== "approve") return rawSimulation("error", [], "0");
      const a = options.approve ?? {};
      return rawSimulation(
        a.mode ?? "ok",
        [authEntry(call.contract, call.args, a.auth ?? {})],
        a.minResourceFee ?? "1000"
      );
    },
  };
}

const build = (options: FakeOptions = {}) =>
  buildRevokeAllowanceTransaction(OWNER, TOKEN, SPENDER, "testnet", { rpc: fakeRpc(options) });

describe("the allowance revocation builder", () => {
  test("builds one plain approve(owner, spender, 0, 0), ready to verify and sign", async () => {
    const result = await build({ sequence: "42" });
    const tx = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET) as Transaction;
    const call = calledFunction(tx);
    expect(call.contract).toBe(TOKEN);
    expect(call.fn).toBe("approve");
    expect(Address.fromScVal(call.args[0]!).toString()).toBe(OWNER);
    expect(Address.fromScVal(call.args[1]!).toString()).toBe(SPENDER);
    expect(result.sourceSequence).toBe("42");
    expect(result.summary).toContain("Revoke the allowance");
  });

  test("the fresh account sequence comes from a live read, not a caller-supplied value", async () => {
    const result = await build({ sequence: "999" });
    const tx = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET) as Transaction;
    // Sequence numbers on a built transaction are pre-incremented by one past the account's own.
    expect(tx.sequence).toBe("1000");
  });

  test("a nonexistent owner account surfaces as its own error, not a generic failure", async () => {
    await expect(build({ accountMissing: true })).rejects.toThrow(/Account not found/);
  });

  test("a restore-required simulation is refused with a named, explanatory error", async () => {
    await expect(build({ approve: { mode: "restore" } })).rejects.toThrow(
      RevokeAllowanceBlockedError
    );
  });

  test("a simulation the network refuses is refused with a named, explanatory error", async () => {
    await expect(build({ approve: { mode: "error" } })).rejects.toThrow(
      RevokeAllowanceBlockedError
    );
  });

  test("a fee beyond what a revocation can need is refused", async () => {
    const promise = build({ approve: { minResourceFee: "20000000" } });
    await expect(promise).rejects.toThrow(RevokeAllowanceBlockedError);
    await expect(promise).rejects.toThrow(/fee exceeds/);
  });

  test("a token whose approve asks the account to authorize anything else is refused, not signed", async () => {
    const cases: Array<[AuthShape, RegExp]> = [
      [{ nested: true }, /nested call/],
      [{ addressCredentials: true }, /credentials other than the account's own/],
      [{ otherFunction: "transfer" }, /other than this revocation/],
      [{ otherContract: OTHER }, /other than this revocation/],
      [
        { otherArgs: [new Address(OWNER).toScVal(), new Address(OTHER).toScVal()] },
        /different arguments/,
      ],
    ];
    for (const [auth, message] of cases) {
      const promise = build({ approve: { auth } });
      await expect(promise).rejects.toThrow(RevokeAllowanceBlockedError);
      await expect(promise).rejects.toThrow(message);
    }
  });
});
