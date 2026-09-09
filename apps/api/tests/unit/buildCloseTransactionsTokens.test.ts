import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as rpcModule from "@/lib/stellar/rpc";
import {
  Account,
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { rawSimulation } from "./fixtures/fake-exit-adapter";

// Wiring coverage for Soroban token dispositions (#161): the token round runs ahead of the classic
// close, a trustline can never be "left", and the plan shows each token as its own step.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const TRANSFER_TO = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const TOKEN = Address.contract(Buffer.alloc(32, 5)).toString();

function trustline(asset: string, balance: string): Trustline {
  const [code, issuer] = asset.split(":");
  return { asset, balance, authorized: true, issuer: issuer!, code: code!, limit: "1000" };
}

function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
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
    ...over,
  };
}

function withToken(balance: string, over: Partial<AccountState> = {}): AccountState {
  return accountState({
    sorobanTokens: {
      tokens: [{ contract: TOKEN, balance, symbol: "XTAR", decimals: 7, sources: ["explorer"] }],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
    ...over,
  });
}

function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    getAssetBalance: () => Promise.reject(new Error("not stubbed")),
  };
}

/** Answers the token's `balance` and simulates its `transfer` under source-account credentials. */
function tokenRpc(balance: bigint): { simulateTransaction: rpc.Server["simulateTransaction"] } {
  return {
    async simulateTransaction(tx) {
      const call = (tx as Transaction)
        .toEnvelope()
        .v1()
        .tx()
        .operations()[0]!
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract();
      if (call.functionName().toString() === "balance") {
        const base = rawSimulation("ok", [], "100") as unknown as Record<string, unknown>;
        return {
          ...base,
          results: [{ auth: [], xdr: nativeToScVal(balance, { type: "i128" }).toXDR("base64") }],
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      const auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: call.contractAddress(),
              functionName: "transfer",
              args: call.args(),
            })
          ),
          subInvocations: [],
        }),
      }).toXDR("base64");
      return rawSimulation("ok", [auth], "1000");
    },
  };
}

afterEach(() => {
  mock.restore();
});

test("a token chosen for transfer is its own first transaction, and the close asks to be called again", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const result = await buildCloseTransactions(
    withToken("250", { trustlines: [trustline(USDC, "100")] }),
    DEST,
    { [TOKEN]: "transfer", [USDC]: "issuer" },
    "testnet",
    null,
    {},
    { [TOKEN]: TRANSFER_TO },
    {},
    { rpc: tokenRpc(250n) }
  );
  expect(result.requiresAnotherCall).toBe(true);
  expect(result.remainingSteps).toBe(1);
  expect(result.transactions).toHaveLength(1);
  const tx = TransactionBuilder.fromXDR(
    result.transactions[0]!.xdr,
    Networks.TESTNET
  ) as Transaction;
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]!.type).toBe("invokeHostFunction");
  const op = result.transactions[0]!.intent.operations[0]!;
  expect(op.type).toBe("invoke_host_function");
  if (op.type === "invoke_host_function") {
    expect(op.contract).toBe(TOKEN);
    expect(op.function).toBe("transfer");
    expect(op.args).toEqual([SOURCE, TRANSFER_TO, "250"]);
  }
});

test("a token left on record needs no transaction: the classic close builds straight away", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const result = await buildCloseTransactions(
    withToken("250"),
    DEST,
    { [TOKEN]: "leave" },
    "testnet",
    null,
    {},
    {},
    {},
    {
      rpc: {
        simulateTransaction: () => Promise.reject(new Error("the token round must not run")),
      },
    }
  );
  expect(result.requiresAnotherCall).toBe(false);
  const tx = TransactionBuilder.fromXDR(
    result.transactions[0]!.xdr,
    Networks.TESTNET
  ) as Transaction;
  expect(tx.operations.map((o) => o.type)).toContain("accountMerge");
});

test("a trustline cannot be left: the answer is refused by name, never converted in silence", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions, CloseBuildError } =
    await import("@/lib/close-api/build-transactions");
  const promise = buildCloseTransactions(
    accountState({ trustlines: [trustline(USDC, "100")] }),
    DEST,
    { [USDC]: "leave" as never },
    "testnet"
  );
  await expect(promise).rejects.toBeInstanceOf(CloseBuildError);
  await expect(promise).rejects.toMatchObject({ code: "trustline_cannot_be_left", status: 422 });
});

const affordability = { revocable: [], unaffordableOwners: new Map() };

test("the plan shows a token transfer as its own step ahead of the classic close, and the close no longer fuses", () => {
  const plan = buildPlan(
    withToken("2500000000", { trustlines: [trustline(USDC, "0")] }),
    false,
    true,
    {},
    affordability,
    { [TOKEN]: "transfer" },
    { [TOKEN]: TRANSFER_TO },
    emptyDefiPositionsResult(SOURCE)
  );
  const tokenStep = plan.steps.find((s) => s.affectedAsset === TOKEN);
  expect(tokenStep).toMatchObject({ type: "HANDLE_ASSETS", operationCount: 1 });
  expect(tokenStep!.title).toContain("Send XTAR to");
  expect(tokenStep!.description).toContain("250 XTAR");
  expect(plan.steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
  expect(plan.steps.findIndex((s) => s.affectedAsset === TOKEN)).toBeLessThan(
    plan.steps.findIndex((s) => s.type === "MERGE")
  );
});

test("a token left on record is a step with nothing to sign, shown so the review carries what stays behind", () => {
  const plan = buildPlan(
    withToken("7", { trustlines: [trustline(USDC, "0")] }),
    false,
    true,
    {},
    affordability,
    { [TOKEN]: "leave" },
    {},
    emptyDefiPositionsResult(SOURCE)
  );
  const tokenStep = plan.steps.find((s) => s.affectedAsset === TOKEN);
  expect(tokenStep).toMatchObject({ type: "HANDLE_ASSETS", operationCount: 0 });
  expect(tokenStep!.title).toBe("Leave XTAR with this address");
  // Nothing else stops the close from fusing into one classic transaction.
  expect(plan.steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(true);
});

test("a token without a decision yet still keeps the close out of the fused shape", () => {
  const plan = buildPlan(
    withToken("7", { trustlines: [trustline(USDC, "0")] }),
    false,
    true,
    {},
    affordability,
    {},
    {},
    emptyDefiPositionsResult(SOURCE)
  );
  expect(plan.steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
  expect(plan.steps.find((s) => s.affectedAsset === TOKEN)!.title).toBe(
    "Send XTAR to another account"
  );
});

test("a trustline answered leave is refused before any token moves: the token round never runs", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  let simulated = 0;
  const promise = buildCloseTransactions(
    withToken("250", { trustlines: [trustline(USDC, "100")] }),
    DEST,
    { [TOKEN]: "transfer", [USDC]: "leave" as never },
    "testnet",
    null,
    {},
    { [TOKEN]: TRANSFER_TO },
    {},
    {
      rpc: {
        simulateTransaction: () => {
          simulated++;
          return Promise.reject(new Error("must not run"));
        },
      },
    }
  );
  await expect(promise).rejects.toMatchObject({ code: "trustline_cannot_be_left", status: 422 });
  expect(simulated).toBe(0);
});

test("convert for a Soroban token is refused by name until conversion is built, never left to the merge", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const promise = buildCloseTransactions(withToken("250"), DEST, { [TOKEN]: "convert" }, "testnet");
  await expect(promise).rejects.toMatchObject({
    code: "soroban_token_conversion_unavailable",
    status: 422,
  });
});

test("with conversion switched off a token's convert answer is refused; switched on, the conversion round runs after the transfers", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const off = buildCloseTransactions(
    withToken("250"),
    DEST,
    { [TOKEN]: "convert" },
    "testnet",
    null,
    {},
    {},
    {},
    {},
    { enabled: false, floors: { [TOKEN]: "1" } }
  );
  await expect(off).rejects.toMatchObject({ code: "soroban_token_conversion_unavailable" });

  // On, with a quote but no verified Soroswap contracts on this network: the round reached the
  // registry gate, which is the last check before a build is requested.
  const on = buildCloseTransactions(
    withToken("250"),
    DEST,
    { [TOKEN]: "convert" },
    "testnet",
    null,
    {},
    {},
    {},
    { rpc: tokenRpc(250n) },
    {
      enabled: true,
      floors: { [TOKEN]: "1" },
      deps: {
        rpc: tokenRpc(250n) as never,
        conversion: {
          sdk: {
            quote: async (req) =>
              ({
                assetIn: req.assetIn,
                assetOut: req.assetOut,
                amountIn: req.amount,
                amountOut: 1_000n,
                otherAmountThreshold: 1_000n,
                priceImpactPct: "0",
                platform: "router",
                routePlan: [],
                tradeType: req.tradeType,
                rawTrade: { amountIn: req.amount, amountOutMin: 1_000n, path: [] },
              }) as never,
            build: async () => ({ xdr: "", action: "", description: "" }),
          },
          now: () => Date.now(),
        },
        allowed: () => ({ aggregator: [], adapters: [], routers: [] }),
      },
    }
  );
  await expect(on).rejects.toMatchObject({ code: "soroban_token_conversion_unavailable" });
  await expect(on).rejects.toThrow(/no verified Soroswap entries/);
});
