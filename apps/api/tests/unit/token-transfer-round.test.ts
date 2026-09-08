/**
 * The Soroban token round: one plain `transfer(account, destination, balance)` per token the user
 * chose to send as-is, simulated, assembled, and refused by name whenever its shape is anything
 * other than that one call under the account's own credentials.
 */
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import {
  TokenTransferBlockedError,
  buildTokenTransferRound,
} from "@/lib/close-api/token-transfer-round";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { rawSimulation } from "./fixtures/fake-exit-adapter";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const TOKEN_A = Address.contract(Buffer.alloc(32, 1)).toString();
const TOKEN_B = Address.contract(Buffer.alloc(32, 2)).toString();
const OTHER = Address.contract(Buffer.alloc(32, 9)).toString();
const OTHER_DEST = Keypair.random().publicKey();

function account(
  tokens: Array<{ contract: string; balance: string; symbol?: string }>
): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    sorobanTokens: {
      tokens: tokens.map((t) => ({
        contract: t.contract,
        balance: t.balance,
        symbol: t.symbol ?? "TKN",
        decimals: 7,
        sources: ["list"],
      })),
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
  };
}

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
  /** The token's transfer under the account's own credentials, as a well-behaved token asks. */
  nested?: boolean;
  addressCredentials?: boolean;
  otherFunction?: string;
  otherContract?: string;
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
          address: new Address(SOURCE).toScAddress(),
          nonce: new xdr.Int64(1),
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        })
      )
    : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: fn(shape.otherContract ?? token, shape.otherFunction ?? "transfer", args),
      subInvocations: shape.nested
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: fn(OTHER, "transfer", []),
              subInvocations: [],
            }),
          ]
        : [],
    }),
  }).toXDR("base64");
}

interface FakeOptions {
  balances: Record<string, bigint>;
  /** How the token's `transfer` simulates: the auth it asks for, or a failure. */
  transfer?: { auth?: AuthShape; mode?: "ok" | "error" | "restore"; minResourceFee?: string };
}

function fakeRpc(options: FakeOptions): {
  simulateTransaction: rpc.Server["simulateTransaction"];
  simulated: Array<{ contract: string; fn: string }>;
} {
  const simulated: Array<{ contract: string; fn: string }> = [];
  return {
    simulated,
    async simulateTransaction(tx) {
      const call = calledFunction(tx as Transaction);
      simulated.push({ contract: call.contract, fn: call.fn });
      if (call.fn === "balance") {
        const balance = options.balances[call.contract];
        if (balance === undefined) return rawSimulation("error", [], "0");
        const base = rawSimulation("ok", [], "100") as unknown as Record<string, unknown>;
        return {
          ...base,
          results: [
            {
              auth: [],
              // A hostile or exotic token may answer with a u128 past what a transfer can carry.
              xdr: nativeToScVal(balance, {
                type: balance > 2n ** 127n - 1n ? "u128" : "i128",
              }).toXDR("base64"),
            },
          ],
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      if (call.fn === "transfer") {
        const t = options.transfer ?? {};
        return rawSimulation(
          t.mode ?? "ok",
          [authEntry(call.contract, call.args, t.auth ?? {})],
          t.minResourceFee ?? "1000"
        );
      }
      return rawSimulation("error", [], "0");
    },
  };
}

const build = (
  state: AccountState,
  dispositions: Record<string, "transfer" | "leave" | "convert">,
  destinations: Record<string, string>,
  options: FakeOptions
) =>
  buildTokenTransferRound(state, dispositions, destinations, "testnet", "100", 5_000, {
    rpc: fakeRpc(options),
  });

describe("the Soroban token transfer round", () => {
  test("builds one plain transfer of the live balance to the chosen account, ready to verify and sign", async () => {
    const round = await build(
      account([{ contract: TOKEN_A, balance: "500", symbol: "XTAR" }]),
      { [TOKEN_A]: "transfer" },
      { [TOKEN_A]: DEST },
      { balances: { [TOKEN_A]: 700n } } // grew since the analysis: the live figure wins
    );
    expect(round).not.toBeNull();
    const tx = TransactionBuilder.fromXDR(round!.transaction.xdr, Networks.TESTNET) as Transaction;
    const call = calledFunction(tx);
    expect(call.contract).toBe(TOKEN_A);
    expect(call.fn).toBe("transfer");
    expect(Address.fromScVal(call.args[0]!).toString()).toBe(SOURCE);
    expect(Address.fromScVal(call.args[1]!).toString()).toBe(DEST);
    expect(round!.transaction.covers).toEqual(["HANDLE_ASSETS"]);
    expect(round!.transaction.sourceSequence).toBe("100");
    expect(round!.remainingSteps).toBe(0);
    const op = round!.transaction.intent.operations[0]!;
    expect(op.type).toBe("invoke_host_function");
    if (op.type === "invoke_host_function") {
      expect(op.args).toEqual([SOURCE, DEST, "700"]);
      expect(op.authDepth).toBe(0);
      expect(op.authorizesBeyondSelf).toBe(false);
      expect(op.accountsReferenced.sort()).toEqual([SOURCE, DEST].sort());
      expect(op.contractsReferenced).toEqual([TOKEN_A]);
    }
    // 700 base units at 7 decimals, rendered the way the plan step renders it.
    expect(round!.transaction.intent.summary).toContain("Send 0.00007 XTAR to");
  });

  test("one token per round, in a stable order, and a balance already moved is skipped for the next", async () => {
    const state = account([
      { contract: TOKEN_B, balance: "5" },
      { contract: TOKEN_A, balance: "5" },
    ]);
    const first = await build(
      state,
      { [TOKEN_A]: "transfer", [TOKEN_B]: "transfer" },
      { [TOKEN_A]: DEST, [TOKEN_B]: DEST },
      { balances: { [TOKEN_A]: 5n, [TOKEN_B]: 5n } }
    );
    expect(
      calledFunction(
        TransactionBuilder.fromXDR(first!.transaction.xdr, Networks.TESTNET) as Transaction
      ).contract
    ).toBe([TOKEN_A, TOKEN_B].sort()[0]);
    expect(first!.remainingSteps).toBe(1);

    // The next round finds the first token gone and moves straight to the second.
    const [moved, next] = [TOKEN_A, TOKEN_B].sort();
    const second = await build(
      state,
      { [TOKEN_A]: "transfer", [TOKEN_B]: "transfer" },
      { [TOKEN_A]: DEST, [TOKEN_B]: DEST },
      { balances: { [moved!]: 0n, [next!]: 5n } }
    );
    expect(
      calledFunction(
        TransactionBuilder.fromXDR(second!.transaction.xdr, Networks.TESTNET) as Transaction
      ).contract
    ).toBe(next);
    expect(second!.remainingSteps).toBe(0);

    // Both gone: nothing left for this round.
    const done = await build(
      state,
      { [TOKEN_A]: "transfer", [TOKEN_B]: "transfer" },
      { [TOKEN_A]: DEST, [TOKEN_B]: DEST },
      { balances: { [TOKEN_A]: 0n, [TOKEN_B]: 0n } }
    );
    expect(done).toBeNull();
  });

  test("tokens left on record, or chosen for conversion, are not this round's business", async () => {
    const round = await build(
      account([
        { contract: TOKEN_A, balance: "5" },
        { contract: TOKEN_B, balance: "5" },
      ]),
      { [TOKEN_A]: "leave", [TOKEN_B]: "convert" },
      {},
      { balances: { [TOKEN_A]: 5n, [TOKEN_B]: 5n } }
    );
    expect(round).toBeNull();
  });

  test("a transfer with no destination is refused by name, never defaulted", async () => {
    const promise = build(
      account([{ contract: TOKEN_A, balance: "5" }]),
      { [TOKEN_A]: "transfer" },
      {},
      { balances: { [TOKEN_A]: 5n } }
    );
    await expect(promise).rejects.toBeInstanceOf(TokenTransferBlockedError);
    await expect(promise).rejects.toMatchObject({ code: "transfer_destination_missing" });
  });

  test("a token that will not report its balance stops the build: the user chose to keep that value", async () => {
    const promise = build(
      account([{ contract: TOKEN_A, balance: "5" }]),
      { [TOKEN_A]: "transfer" },
      { [TOKEN_A]: DEST },
      { balances: {} }
    );
    await expect(promise).rejects.toMatchObject({ code: "soroban_token_unreadable" });
  });

  test("a transfer the ledger refuses in simulation, or one needing a restore, is a plain-language stop", async () => {
    const refused = build(
      account([{ contract: TOKEN_A, balance: "5" }]),
      { [TOKEN_A]: "transfer" },
      { [TOKEN_A]: DEST },
      { balances: { [TOKEN_A]: 5n }, transfer: { mode: "error" } }
    );
    await expect(refused).rejects.toMatchObject({ code: "soroban_token_transfer_failed" });
    const archived = build(
      account([{ contract: TOKEN_A, balance: "5" }]),
      { [TOKEN_A]: "transfer" },
      { [TOKEN_A]: DEST },
      { balances: { [TOKEN_A]: 5n }, transfer: { mode: "restore" } }
    );
    await expect(archived).rejects.toMatchObject({ code: "soroban_token_needs_restore" });
  });

  test("a token whose transfer asks the account to authorize anything else is refused, not signed", async () => {
    const cases: Array<[AuthShape, RegExp]> = [
      [{ nested: true }, /nested call/],
      [{ addressCredentials: true }, /credentials other than the account's own/],
      [{ otherFunction: "approve" }, /other than this transfer/],
      [{ otherContract: OTHER }, /other than this transfer/],
    ];
    for (const [auth, message] of cases) {
      const promise = build(
        account([{ contract: TOKEN_A, balance: "5" }]),
        { [TOKEN_A]: "transfer" },
        { [TOKEN_A]: DEST },
        { balances: { [TOKEN_A]: 5n }, transfer: { auth } }
      );
      await expect(promise).rejects.toMatchObject({ code: "soroban_token_transfer_unsafe" });
      await expect(promise).rejects.toThrow(message);
    }
  });

  test("a fee beyond what a transfer can need is refused", async () => {
    const promise = build(
      account([{ contract: TOKEN_A, balance: "5" }]),
      { [TOKEN_A]: "transfer" },
      { [TOKEN_A]: DEST },
      { balances: { [TOKEN_A]: 5n }, transfer: { minResourceFee: "20000000" } }
    );
    await expect(promise).rejects.toMatchObject({ code: "soroban_token_transfer_unsafe" });
    await expect(promise).rejects.toThrow(/fee exceeds/);
  });

  test("an answered token missing from a read that fell short stops the close; missing from a clean read, it has moved", async () => {
    const withWarning = account([]);
    withWarning.sorobanTokens!.warnings = [{ code: "soroban_tokens_partial", message: "x" }];
    await expect(
      build(withWarning, { [TOKEN_A]: "transfer" }, { [TOKEN_A]: DEST }, { balances: {} })
    ).rejects.toMatchObject({ code: "soroban_token_unreadable" });

    const unreadable = account([]);
    unreadable.sorobanTokens!.unreadable = [TOKEN_A];
    await expect(
      build(unreadable, { [TOKEN_A]: "transfer" }, { [TOKEN_A]: DEST }, { balances: {} })
    ).rejects.toMatchObject({ code: "soroban_token_unreadable" });

    const noRead = account([]);
    delete (noRead as { sorobanTokens?: unknown }).sorobanTokens;
    await expect(
      build(noRead, { [TOKEN_A]: "transfer" }, { [TOKEN_A]: DEST }, { balances: {} })
    ).rejects.toMatchObject({ code: "soroban_token_unreadable" });

    // A clean read that simply no longer lists the token: its balance is zero, it was moved.
    await expect(
      build(account([]), { [TOKEN_A]: "transfer" }, { [TOKEN_A]: DEST }, { balances: {} })
    ).resolves.toBeNull();
  });

  test("a balance beyond what an i128 transfer can carry is refused by name, not a crash", async () => {
    await expect(
      build(
        account([{ contract: TOKEN_A, balance: "5" }]),
        { [TOKEN_A]: "transfer" },
        { [TOKEN_A]: DEST },
        { balances: { [TOKEN_A]: 2n ** 127n } }
      )
    ).rejects.toMatchObject({ code: "soroban_token_unreadable" });
  });

  test("an authorization entry whose arguments differ from the call, or no entry at all, is refused", async () => {
    const rpcNoAuth = fakeRpc({ balances: { [TOKEN_A]: 5n } });
    const original = rpcNoAuth.simulateTransaction.bind(rpcNoAuth);
    rpcNoAuth.simulateTransaction = (async (tx) => {
      const call = calledFunction(tx as Transaction);
      if (call.fn === "transfer") return rawSimulation("ok", [], "1000");
      return original(tx);
    }) as typeof rpcNoAuth.simulateTransaction;
    await expect(
      buildTokenTransferRound(
        account([{ contract: TOKEN_A, balance: "5" }]),
        { [TOKEN_A]: "transfer" },
        { [TOKEN_A]: DEST },
        "testnet",
        "100",
        5_000,
        { rpc: rpcNoAuth }
      )
    ).rejects.toThrow(/no authorization/);

    const rpcOtherArgs = fakeRpc({ balances: { [TOKEN_A]: 5n } });
    const orig2 = rpcOtherArgs.simulateTransaction.bind(rpcOtherArgs);
    rpcOtherArgs.simulateTransaction = (async (tx) => {
      const call = calledFunction(tx as Transaction);
      if (call.fn === "transfer") {
        const swapped = [call.args[0]!, new Address(OTHER_DEST).toScVal(), call.args[2]!];
        return rawSimulation("ok", [authEntry(TOKEN_A, swapped)], "1000");
      }
      return orig2(tx);
    }) as typeof rpcOtherArgs.simulateTransaction;
    await expect(
      buildTokenTransferRound(
        account([{ contract: TOKEN_A, balance: "5" }]),
        { [TOKEN_A]: "transfer" },
        { [TOKEN_A]: DEST },
        "testnet",
        "100",
        5_000,
        { rpc: rpcOtherArgs }
      )
    ).rejects.toThrow(/different arguments/);
  });
});
