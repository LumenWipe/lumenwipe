import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { callOf, onlyOperation } from "../support/xdr-edit";
import * as rpcModule from "@/lib/stellar/rpc";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as registry from "@/lib/exchange-registry";
import * as networks from "@/config/networks";
import * as feeAccount from "@/lib/stellar/fee-account";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { AccountState, OpenOffer, Trustline } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import type { ExitRunResult } from "@/lib/defi-exits";
import { DEGRADED_SOURCE_CONFIRMED } from "@/lib/defi-positions/resolve-defi-positions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { SOROBAN_EXIT_FEE_ESTIMATE_STROOPS } from "@/config/constants";
import { stroopsToFixedXlm } from "@/lib/utils/amounts";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { rawSimulation } from "./fixtures/fake-exit-adapter";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MEDIATOR = Keypair.random().publicKey();
const TRANSFER_TO = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const TOKEN = Address.contract(Buffer.alloc(32, 7)).toString();
const ONE_XLM = 10_000_000n;
const HALF_XLM = 5_000_000n;
const MERGE_FEE = 200n;
const ESTIMATE = BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS);
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_ASSET = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

let snapshot: Trustline[] = [];

function trustline(balance: string): Trustline {
  return {
    asset: USDC,
    balance,
    ...authorizationOf(true),
    issuer: ISSUER,
    code: "USDC",
    limit: "1000",
  };
}

function nativeOffer(amount: string): OpenOffer {
  return { id: "1", selling: "native", buying: USDC, amount, price: "1" };
}

function state(balanceStroops: bigint, over: Partial<AccountState> = {}): AccountState {
  const s: AccountState = {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: stroopsToFixedXlm(balanceStroops),
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
    ...over,
  };
  snapshot = s.trustlines;
  return s;
}

function withToken(balanceStroops: bigint, over: Partial<AccountState> = {}): AccountState {
  return state(balanceStroops, {
    sorobanTokens: {
      tokens: [{ contract: TOKEN, balance: "250", symbol: "XTAR", decimals: 7, sources: [] }],
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
    getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot),
  };
}

function tokenRpc(): { simulateTransaction: rpc.Server["simulateTransaction"] } {
  return {
    async simulateTransaction(tx) {
      const call = callOf(onlyOperation(tx as Transaction));
      if (call.functionName.toString() === "balance") {
        const base = rawSimulation("ok", [], "100") as unknown as Record<string, unknown>;
        return {
          ...base,
          results: [{ auth: [], xdr: nativeToScVal(250n, { type: "i128" }).toXDR("base64") }],
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      const auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: call.contractAddress,
              functionName: "transfer",
              args: call.args,
            })
          ),
          subInvocations: [],
        }),
      }).toXDR("base64");
      return rawSimulation("ok", [auth], "1000");
    },
  };
}

/** 100 stroops for each classic operation the close may still need: the signer and the merge. */
const CLASSIC_FEES = 200n;

function sponsorConfigured(): void {
  spyOn(feeAccount, "getFeeAccountKeypair").mockReturnValue(Keypair.random());
}

function withPosition(balanceStroops: bigint): AccountState {
  return state(balanceStroops, {
    defiPositions: {
      ...emptyDefiPositionsResult(SOURCE),
      source: DEGRADED_SOURCE_CONFIRMED,
      timestamp: null,
      positions: [
        {
          protocol: "blend",
          positionType: "supply",
          contractAddress: POOL,
          assetAddress: POOL_ASSET,
          bTokenAmount: "1",
          usdValue: null,
        },
      ],
    },
  });
}

function oneStepExit(): ExitRunResult {
  const step = {
    kind: "withdraw" as const,
    contract: POOL,
    function: "submit",
    asset: POOL_ASSET,
    amount: "1",
    ceiling: "1",
    minReceived: [],
    description: "withdraw",
  };
  const txXdr = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: POOL, function: "submit", args: [] })
    )
    .setTimeout(300)
    .build()
    .toXDR();
  return {
    contract: POOL,
    resolution: {
      status: "known",
      protocol: "blend",
      kind: "pool",
      version: "v2",
      wasmHash: "a".repeat(64),
    },
    plan: [step],
    next: {
      step,
      build: {
        source: "local",
        op: Operation.invokeContractFunction({ contract: POOL, function: "submit", args: [] }),
      },
      intent: { contract: POOL, function: "submit", args: [], minReceived: [], recipient: SOURCE },
      simulation: { minResourceFee: "1", latestLedger: 1, txXdr },
    },
    blockers: [],
  } as unknown as ExitRunResult;
}

function exitRound(s: AccountState) {
  return buildCloseTransactions(
    s,
    DEST,
    {},
    "testnet",
    null,
    {},
    {},
    {
      runExitAdapter: async () => oneStepExit(),
    }
  );
}

function viaExchange(): void {
  spyOn(registry, "requiresMediatorForAddress").mockReturnValue(true);
  spyOn(networks, "getMediatorPublicKey").mockReturnValue(MEDIATOR);
}

async function refusal(promise: Promise<unknown>): Promise<CloseBuildError> {
  const failure = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(CloseBuildError);
  return failure as CloseBuildError;
}

function tokenTransfer(s: AccountState) {
  return buildCloseTransactions(
    s,
    DEST,
    { [TOKEN]: "transfer" },
    "testnet",
    null,
    {},
    { [TOKEN]: TRANSFER_TO },
    {},
    { rpc: tokenRpc() }
  );
}

async function tokenTransferFee(): Promise<bigint> {
  const result = await tokenTransfer(withToken(100n * ONE_XLM));
  return BigInt(TransactionBuilder.fromXDR(result.transactions[0]!.xdr, Networks.TESTNET).fee);
}

beforeEach(() => {
  stubIssuance();
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
});

afterEach(() => {
  mock.restore();
});

test("soroban round › built when the account can pay its fee and what follows, refused one stroop short", async () => {
  const fee = await tokenTransferFee();

  const exact = await tokenTransfer(withToken(ONE_XLM + fee + CLASSIC_FEES));
  expect(exact.transactions).toHaveLength(1);

  const short = await refusal(tokenTransfer(withToken(ONE_XLM + fee + CLASSIC_FEES - 1n)));
  expect(short).toMatchObject({ code: "close_fee_balance_short", status: 422 });
  expect(short.message).toContain("0.0000001 XLM");
});

test("soroban round › XLM held by an open offer is not counted as spendable", async () => {
  const fee = await tokenTransferFee();
  const offers = { openOffers: [nativeOffer("0.5000000")], numSubEntries: 1 };
  const owed = fee + CLASSIC_FEES + 100n;

  const fits = await tokenTransfer(withToken(ONE_XLM + HALF_XLM + HALF_XLM + owed, offers));
  expect(fits.transactions).toHaveLength(1);

  const short = await refusal(
    tokenTransfer(withToken(ONE_XLM + HALF_XLM + HALF_XLM + owed - 1n, offers))
  );
  expect(short.code).toBe("close_fee_balance_short");
});

test("soroban round › reserves another account pays for lower what must stay untouched", async () => {
  const fee = await tokenTransferFee();
  const sponsored = { numSponsored: 2 };

  const fits = await tokenTransfer(withToken(fee + CLASSIC_FEES, sponsored));
  expect(fits.transactions).toHaveLength(1);

  const short = await refusal(tokenTransfer(withToken(fee + CLASSIC_FEES - 1n, sponsored)));
  expect(short.code).toBe("close_fee_balance_short");
});

test("soroban round › an exchange close also keeps the merge fee, which no sponsor can pay", async () => {
  viaExchange();
  const fee = await tokenTransferFee();

  const short = await refusal(
    tokenTransfer(withToken(ONE_XLM + fee + CLASSIC_FEES + MERGE_FEE - 1n))
  );
  expect(short.code).toBe("close_fee_balance_short");

  const fits = await tokenTransfer(withToken(ONE_XLM + fee + CLASSIC_FEES + MERGE_FEE));
  expect(fits.transactions).toHaveLength(1);
});

test("soroban round › rounds still to come are reserved at the plan's estimate", async () => {
  const fee = await tokenTransferFee();
  const second = Address.contract(Buffer.alloc(32, 8)).toString();
  const twoTokens = (balance: bigint) =>
    buildCloseTransactions(
      withToken(balance, {
        sorobanTokens: {
          tokens: [
            { contract: TOKEN, balance: "250", symbol: "XTAR", decimals: 7, sources: [] },
            { contract: second, balance: "250", symbol: "YTAR", decimals: 7, sources: [] },
          ],
          unreadable: [],
          coverage: [],
          eventsScanned: null,
          warnings: [],
        },
      }),
      DEST,
      { [TOKEN]: "transfer", [second]: "transfer" },
      "testnet",
      null,
      {},
      { [TOKEN]: TRANSFER_TO, [second]: TRANSFER_TO },
      {},
      { rpc: tokenRpc() }
    );

  const short = await refusal(twoTokens(ONE_XLM + fee + ESTIMATE + CLASSIC_FEES - 1n));
  expect(short.code).toBe("close_fee_balance_short");

  const fits = await twoTokens(ONE_XLM + fee + ESTIMATE + CLASSIC_FEES);
  expect(fits.transactions).toHaveLength(1);
});

test("exit round › the exit is built only when the account can also pay the rounds after it", async () => {
  // One later round is reserved for each position, at the estimate.
  const owed = 100n + ESTIMATE + CLASSIC_FEES;

  const fits = await exitRound(withPosition(ONE_XLM + owed));
  expect(fits.transactions[0]!.covers).toEqual(["EXIT_POSITIONS"]);

  const short = await refusal(exitRound(withPosition(ONE_XLM + owed - 1n)));
  expect(short.code).toBe("close_fee_balance_short");
});

test("exchange merge › refused below the least forward plus its fee, built at exactly that", async () => {
  viaExchange();
  const sponsoredAccount = { numSponsored: 2 };

  const short = await refusal(
    buildCloseTransactions(state(ONE_XLM + MERGE_FEE - 1n, sponsoredAccount), DEST, {}, "testnet")
  );
  expect(short.code).toBe("close_fee_balance_short");

  const built = await buildCloseTransactions(
    state(ONE_XLM + MERGE_FEE, sponsoredAccount),
    DEST,
    {},
    "testnet"
  );
  const ops = TransactionBuilder.fromXDR(built.transactions[0]!.xdr, Networks.TESTNET).operations;
  expect(ops.map((o) => o.type)).toEqual(["accountMerge", "payment"]);
});

test("exchange merge › an unconfigured relay is reported as such, not as a fee shortfall", async () => {
  spyOn(registry, "requiresMediatorForAddress").mockReturnValue(true);
  spyOn(networks, "getMediatorPublicKey").mockReturnValue(null as unknown as string);

  const failure = await refusal(buildCloseTransactions(state(1n), DEST, {}, "testnet"));
  expect(failure.code).toBe("mediator_not_configured");
});

test("exchange cleanup › refused before anything is built when the merge after it could not be paid", async () => {
  viaExchange();
  // The account's own reserve is sponsored, so 0.5 XLM covers its one trustline; cleanup then
  // pays its own 100 stroop fee and must still leave the least forward plus the merge fee.
  const emptyLine = { trustlines: [trustline("0")], numSubEntries: 1, numSponsored: 2 };

  const short = await refusal(
    buildCloseTransactions(state(ONE_XLM + MERGE_FEE + 99n, emptyLine), DEST, {}, "testnet")
  );
  expect(short.code).toBe("close_fee_balance_short");
  expect(short.message).toContain("0.0000001 XLM");

  const built = await buildCloseTransactions(
    state(ONE_XLM + MERGE_FEE + 100n, emptyLine),
    DEST,
    {},
    "testnet"
  );
  expect(built.requiresAnotherCall).toBe(true);
  expect(built.transactions[0]!.needsSponsoredFee).toBeUndefined();
});

test("exchange cleanup › a conversion's destination minimum counts toward what the merge will have", async () => {
  viaExchange();
  sponsorConfigured();
  const route = (destMin: string) =>
    spyOn(pathFinding, "fetchConversionPath").mockResolvedValue({
      kind: "route",
      path: { fromAsset: USDC, toAsset: "native", path: [], estimatedReceive: destMin, destMin },
    });
  // The trustline's reserve is sponsored: the account sits exactly at its 1 XLM minimum, so the
  // cleanup is sponsored and the conversion alone has to bring the merge's fee.
  const funded = { trustlines: [trustline("1.0000000")], numSubEntries: 1, numSponsored: 1 };

  route("0.0000200");
  const built = await buildCloseTransactions(state(ONE_XLM, funded), DEST, {}, "testnet");
  expect(built.transactions[0]!.needsSponsoredFee).toBe(true);

  mock.restore();
  stubIssuance();
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  viaExchange();
  sponsorConfigured();
  route("0.0000199");
  const short = await refusal(buildCloseTransactions(state(ONE_XLM, funded), DEST, {}, "testnet"));
  expect(short.code).toBe("close_fee_balance_short");
});

test("classic round › refused, not flagged, when no sponsor is configured to pay its fee", async () => {
  const atMinimum = { trustlines: [trustline("0")], numSubEntries: 1 };
  const short = await refusal(
    buildCloseTransactions(state(ONE_XLM + HALF_XLM, atMinimum), DEST, {}, "testnet")
  );
  expect(short.code).toBe("close_fee_balance_short");

  sponsorConfigured();
  const built = await buildCloseTransactions(
    state(ONE_XLM + HALF_XLM, atMinimum),
    DEST,
    {},
    "testnet"
  );
  expect(built.transactions[0]!.needsSponsoredFee).toBe(true);
});

test("plan › a close whose Soroban rounds the account cannot pay for is blocked up front", () => {
  const owed = 2n * ESTIMATE + CLASSIC_FEES;
  const blocker = (balance: bigint) =>
    buildPlan(
      withPosition(balance),
      false,
      false,
      {},
      undefined,
      {},
      {},
      withPosition(balance).defiPositions
    ).blockers.find((b) => b.code === "close_fee_balance_short");

  expect(blocker(ONE_XLM + owed)).toBeUndefined();
  expect(blocker(ONE_XLM + owed - 1n)?.message).toContain("0.0000001 XLM");
});
