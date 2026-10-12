import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  AccountState,
  BatchPlanResult,
  DecisionAnswer,
  PlanResponse,
  TransactionsResponse,
} from "@lumenwipe/types";
import { CloseController } from "@/close/close.controller";
import type { StatsService } from "@/stats/stats.service";
import { servedRegistry, type RegistryEntry } from "@/lib/exchange-registry";
import {
  AccountNotFoundError,
  InvalidXdrError,
  TxSubmitError,
  TxTimeoutError,
} from "@/lib/utils/errors";
import { InvalidSignatureError } from "@/lib/stellar/signature";
import { CloseBuildError } from "@/lib/close-api/build-transactions";
import {
  DESTINATION_ACK_CHOICE,
  claimableBalanceDecisionId,
  decisionIdFor,
  destinationDecisionId,
} from "@/lib/close-api/decisions";
import { BATCH_PLAN_MAX_ADDRESSES } from "@/lib/close-api/batch-plan";
import { computePlanHash } from "@/lib/close-api/plan-response";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import * as exchangeRegistryModule from "@/lib/exchange-registry";
import * as readAccountModule from "@/lib/close-api/read-account";
import * as accountPlanModule from "@/lib/close-api/account-plan";
import * as batchPlanModule from "@/lib/close-api/batch-plan";
import * as buildModule from "@/lib/close-api/build-transactions";
import * as preflightModule from "@/lib/close-api/merge-preflight";
import * as transferModule from "@/lib/close-api/transfer-destinations";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as submitModule from "@/lib/stellar/submit";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const HASH = "c".repeat(64);
const TEXT_EXCHANGE = servedRegistry().entries.find((e) => e.memoType === "text")!;
const ID_EXCHANGE = servedRegistry().entries.find((e) => e.memoType === "id")!;
const ACK: DecisionAnswer = { id: destinationDecisionId(DEST), choice: DESTINATION_ACK_CHOICE };
const USDC = `USDC:${ISSUER}`;

function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "77",
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
    ...over,
  };
}

const TX = [{ marker: "tx" }] as unknown as TransactionsResponse["transactions"];
const BUILT = { transactions: [], requiresAnotherCall: false, remainingSteps: 0 };

type Reader = typeof readAccountModule.readAccountState;
type Planner = typeof accountPlanModule.buildAccountPlan;
type BatchPlanner = typeof batchPlanModule.planBatch;
type Builder = typeof buildModule.buildCloseTransactions;
type Preflight = typeof preflightModule.assessMergePreflight;
type TransferCheck = typeof transferModule.validateTransferDestinations;
type TrustlineReader = typeof accountStateModule.readTrustlinesOnly;
type Submitter = typeof submitModule.submitAndWait;

interface Fakes {
  readAccountState: Reader;
  buildAccountPlan: Planner;
  planBatch: BatchPlanner;
  buildCloseTransactions: Builder;
  assessMergePreflight: Preflight;
  validateTransferDestinations: TransferCheck;
  readTrustlinesOnly: TrustlineReader;
  submitAndWait: Submitter;
  record: StatsService["record"];
  lookup: (address: string) => RegistryEntry | null;
  isFresh: () => boolean;
}

const unexpected = (name: string) => () => {
  throw new Error(`unexpected call to ${name}`);
};

function defaults(): Fakes {
  return {
    readAccountState: async () => accountState(),
    buildAccountPlan: unexpected("buildAccountPlan") as Planner,
    planBatch: unexpected("planBatch") as BatchPlanner,
    buildCloseTransactions: async () => BUILT,
    assessMergePreflight: async () => [],
    validateTransferDestinations: async () => [],
    readTrustlinesOnly: unexpected("readTrustlinesOnly") as TrustlineReader,
    submitAndWait: unexpected("submitAndWait") as Submitter,
    record: async () => "counted",
    lookup: (address) => servedRegistry().entries.find((e) => e.address === address) ?? null,
    isFresh: () => true,
  };
}

function makeController(overrides: Partial<Fakes> = {}): {
  controller: CloseController;
  fakes: Fakes;
} {
  const fakes = { ...defaults(), ...overrides };
  spyOn(readAccountModule, "readAccountState").mockImplementation(fakes.readAccountState);
  spyOn(accountPlanModule, "buildAccountPlan").mockImplementation(fakes.buildAccountPlan);
  spyOn(batchPlanModule, "planBatch").mockImplementation(fakes.planBatch);
  spyOn(buildModule, "buildCloseTransactions").mockImplementation(fakes.buildCloseTransactions);
  spyOn(preflightModule, "assessMergePreflight").mockImplementation(fakes.assessMergePreflight);
  spyOn(transferModule, "validateTransferDestinations").mockImplementation(
    fakes.validateTransferDestinations
  );
  spyOn(accountStateModule, "readTrustlinesOnly").mockImplementation(fakes.readTrustlinesOnly);
  spyOn(submitModule, "submitAndWait").mockImplementation(fakes.submitAndWait);
  spyOn(exchangeRegistryModule, "lookupExchange").mockImplementation(fakes.lookup);
  spyOn(exchangeRegistryModule, "isRegistryFresh").mockImplementation(fakes.isFresh);
  spyOn(exchangeRegistryModule, "requiresMediatorForAddress").mockImplementation(
    (address) => fakes.lookup(address)?.requiresMediator ?? false
  );
  const stats = { record: fakes.record } as unknown as StatsService;
  return { controller: new CloseController(stats), fakes };
}

afterEach(() => {
  spyOn(readAccountModule, "readAccountState").mockRestore();
  spyOn(accountPlanModule, "buildAccountPlan").mockRestore();
  spyOn(batchPlanModule, "planBatch").mockRestore();
  spyOn(buildModule, "buildCloseTransactions").mockRestore();
  spyOn(preflightModule, "assessMergePreflight").mockRestore();
  spyOn(transferModule, "validateTransferDestinations").mockRestore();
  spyOn(accountStateModule, "readTrustlinesOnly").mockRestore();
  spyOn(submitModule, "submitAndWait").mockRestore();
  spyOn(exchangeRegistryModule, "lookupExchange").mockRestore();
  spyOn(exchangeRegistryModule, "isRegistryFresh").mockRestore();
  spyOn(exchangeRegistryModule, "requiresMediatorForAddress").mockRestore();
  setSystemTime();
});

async function expectFail(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
  details?: unknown
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const e = err as HttpException;
  expect(e.getStatus()).toBe(status);
  const { error } = e.getResponse() as {
    error: { code: string; message: string; details?: unknown };
  };
  expect(error.code).toBe(code);
  if (message !== undefined) expect(error.message).toBe(message);
  if (details !== undefined) expect(error.details).toEqual(details);
}

const INVALID_SOURCE = "A valid source account (G...) is required.";
const INVALID_DEST = "Destination must be a valid account (G...).";

describe("plan", () => {
  test("P1 a missing or malformed source is refused", async () => {
    const { controller } = makeController();
    await expectFail(controller.plan("testnet", {}), 400, "invalid_source", INVALID_SOURCE);
    await expectFail(controller.plan("testnet", { source: 7 }), 400, "invalid_source");
    await expectFail(controller.plan("testnet", { source: "nope" }), 400, "invalid_source");
  });

  test("P2 a malformed destination is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.plan("testnet", { source: SOURCE, destination: "nope" }),
      400,
      "invalid_destination",
      INVALID_DEST
    );
  });

  test("P3 malformed decisions are refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.plan("testnet", { source: SOURCE, decisions: "nope" }),
      400,
      "invalid_decisions"
    );
  });

  test("P4 a valid request returns the built plan, a non-string destination counting as none", async () => {
    const plan = { marker: "plan" } as unknown as PlanResponse;
    const calls: unknown[][] = [];
    const { controller } = makeController({
      buildAccountPlan: async (...args) => {
        calls.push(args);
        return plan;
      },
    });
    const decisions = [ACK];
    expect(await controller.plan("testnet", { source: SOURCE, destination: DEST, decisions })).toBe(
      plan
    );
    expect(await controller.plan("testnet", { source: SOURCE, destination: 5 })).toBe(plan);
    expect(calls).toEqual([
      [SOURCE, DEST, decisions, "testnet"],
      [SOURCE, null, [], "testnet"],
    ]);
  });

  test("P5 an HttpException from the planner passes through unchanged", async () => {
    const { controller } = makeController({
      buildAccountPlan: async () => {
        throw new HttpException({ error: { code: "x", message: "y" } }, 418);
      },
    });
    await expectFail(controller.plan("testnet", { source: SOURCE }), 418, "x", "y");
  });

  test("P6 a domain error is rethrown for the filter to map", async () => {
    const error = new AccountNotFoundError(SOURCE);
    const { controller } = makeController({
      buildAccountPlan: async () => {
        throw error;
      },
    });
    await expect(controller.plan("testnet", { source: SOURCE })).rejects.toBe(error);
  });

  test("P7 an unexpected failure becomes a plain plan_failed 500", async () => {
    const { controller } = makeController({
      buildAccountPlan: async () => {
        throw new Error("secret internals");
      },
    });
    await expectFail(
      controller.plan("testnet", { source: SOURCE }),
      500,
      "plan_failed",
      "Failed to build the close plan."
    );
  });
});

describe("batchPlan", () => {
  const NEEDS_LIST = "A non-empty array of source accounts (G...) is required.";

  test("B1 a missing, non-array or empty list is refused", async () => {
    const { controller } = makeController();
    await expectFail(controller.batchPlan("testnet", {}), 400, "invalid_addresses", NEEDS_LIST);
    await expectFail(
      controller.batchPlan("testnet", { addresses: "x" }),
      400,
      "invalid_addresses",
      NEEDS_LIST
    );
    await expectFail(
      controller.batchPlan("testnet", { addresses: [] }),
      400,
      "invalid_addresses",
      NEEDS_LIST
    );
  });

  test("B2 more than the maximum is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.batchPlan("testnet", {
        addresses: new Array(BATCH_PLAN_MAX_ADDRESSES + 1).fill(SOURCE),
      }),
      400,
      "too_many_addresses",
      `At most ${BATCH_PLAN_MAX_ADDRESSES} addresses are allowed per batch.`
    );
  });

  test("B3 an entry that is not a valid G address is refused", async () => {
    const { controller } = makeController();
    const message = "Every address must be a valid Stellar account (G...).";
    await expectFail(
      controller.batchPlan("testnet", { addresses: [SOURCE, "nope"] }),
      400,
      "invalid_addresses",
      message
    );
    await expectFail(
      controller.batchPlan("testnet", { addresses: [SOURCE, 3] }),
      400,
      "invalid_addresses",
      message
    );
  });

  test("B4 a malformed destination is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.batchPlan("testnet", { addresses: [SOURCE], destination: "nope" }),
      400,
      "invalid_destination",
      INVALID_DEST
    );
  });

  test("B5 the results are wrapped, a non-string destination counting as none", async () => {
    const results = [{ marker: "result" }] as unknown as BatchPlanResult[];
    const calls: unknown[][] = [];
    const { controller } = makeController({
      planBatch: (async (...args: unknown[]) => {
        calls.push(args);
        return results;
      }) as unknown as BatchPlanner,
    });
    expect(
      await controller.batchPlan("testnet", { addresses: [SOURCE], destination: DEST })
    ).toEqual({ results });
    expect(await controller.batchPlan("testnet", { addresses: [SOURCE] })).toEqual({ results });
    expect(calls).toEqual([
      [[SOURCE], DEST, "testnet"],
      [[SOURCE], null, "testnet"],
    ]);
  });
});

describe("transactions", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    source: SOURCE,
    destination: DEST,
    decisions: [ACK],
    ...over,
  });

  test("T1 a missing or malformed source is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.transactions("testnet", body({ source: undefined })),
      400,
      "invalid_source",
      INVALID_SOURCE
    );
    await expectFail(
      controller.transactions("testnet", body({ source: "nope" })),
      400,
      "invalid_source"
    );
  });

  test("T2 a missing or malformed destination is refused", async () => {
    const { controller } = makeController();
    const message = "A valid destination account (G...) is required.";
    await expectFail(
      controller.transactions("testnet", body({ destination: undefined })),
      400,
      "invalid_destination",
      message
    );
    await expectFail(
      controller.transactions("testnet", body({ destination: "nope" })),
      400,
      "invalid_destination",
      message
    );
  });

  test("T3 malformed decisions are refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.transactions("testnet", body({ decisions: 4 })),
      400,
      "invalid_decisions"
    );
  });

  test("T4 an exchange that needs a memo refuses a close without one", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.transactions("testnet", body({ destination: TEXT_EXCHANGE.address })),
      422,
      "memo_required",
      "This exchange destination requires a deposit memo.",
      { memoType: "text" }
    );
    await expectFail(
      controller.transactions("testnet", body({ destination: ID_EXCHANGE.address, memo: "" })),
      422,
      "memo_required"
    );
  });

  test("T5 a hash memo is not supported", async () => {
    const { controller } = makeController({
      lookup: () => ({ ...TEXT_EXCHANGE, memoType: "hash" }),
    });
    await expectFail(
      controller.transactions("testnet", body({ memo: "abc" })),
      422,
      "unsupported_memo_type",
      "Hash memos are not supported."
    );
  });

  test("T6 an id memo must be a uint64", async () => {
    const { controller } = makeController();
    const message = "This destination requires a numeric id memo within the uint64 range.";
    const to = (memo: string) =>
      controller.transactions("testnet", body({ destination: ID_EXCHANGE.address, memo }));
    await expectFail(to("12ab"), 422, "invalid_memo", message);
    await expectFail(to("18446744073709551616"), 422, "invalid_memo", message);
    expect((await to("18446744073709551615")).status).toBe("ready");
  });

  test("T7 a text memo is limited to 28 bytes", async () => {
    const { controller } = makeController();
    const to = (memo: string) =>
      controller.transactions("testnet", body({ destination: TEXT_EXCHANGE.address, memo }));
    await expectFail(
      to("a".repeat(29)),
      422,
      "invalid_memo",
      "A text memo must be at most 28 bytes."
    );
    await expectFail(to("é".repeat(15)), 422, "invalid_memo");
    expect((await to("a".repeat(28))).status).toBe("ready");
  });

  test("T8 an exchange close is refused once the registry has expired", async () => {
    const { controller } = makeController({ isFresh: () => false });
    await expectFail(
      controller.transactions("testnet", body({ destination: TEXT_EXCHANGE.address, memo: "m" })),
      503,
      "registry_expired"
    );
  });

  test("T8b a personal-wallet close does not depend on the registry", async () => {
    const { controller } = makeController({ isFresh: () => false });
    expect((await controller.transactions("testnet", body())).status).toBe("ready");
  });

  test("T9 an unrecognized destination must be acknowledged", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.transactions("testnet", body({ decisions: [] })),
      422,
      "destination_not_acknowledged",
      undefined,
      { decisionId: destinationDecisionId(DEST), choice: DESTINATION_ACK_CHOICE }
    );
  });

  test("T9b an exchange destination needs no acknowledgement", async () => {
    const { controller } = makeController();
    const result = await controller.transactions(
      "testnet",
      body({ destination: TEXT_EXCHANGE.address, memo: "m", decisions: [] })
    );
    expect(result.status).toBe("ready");
  });

  test("T10 a held asset without a disposition answer is reported as missing", async () => {
    const { controller } = makeController({
      readAccountState: async () =>
        accountState({
          trustlines: [
            {
              asset: USDC,
              balance: "5.0000000",
              limit: "1000",
              authorized: true,
              issuer: ISSUER,
              code: "USDC",
            },
          ],
        }),
    });
    await expectFail(
      controller.transactions("testnet", body()),
      422,
      "needs_decisions",
      "Resolve every pending decision before requesting transactions.",
      { missing: [decisionIdFor(USDC)] }
    );
  });

  test("T10b an unclaimable balance without a selection is reported as missing", async () => {
    const id = "0".repeat(72);
    const { controller } = makeController({
      readAccountState: async () =>
        accountState({
          claimableBalances: [
            { id, asset: USDC, amount: "1.0000000", claimants: [], sponsor: null },
          ],
        }),
    });
    await expectFail(
      controller.transactions("testnet", body()),
      422,
      "needs_decisions",
      undefined,
      { missing: [claimableBalanceDecisionId(id)] }
    );
  });

  test("T11 a merge preflight problem is reported under its own code", async () => {
    const problem = {
      code: "destination_missing",
      message: "The destination does not exist.",
    } as const;
    const { controller } = makeController({ assessMergePreflight: async () => [problem] });
    await expectFail(
      controller.transactions("testnet", body()),
      422,
      "merge_destination_unusable",
      problem.message,
      { problems: [problem] }
    );
    const sequence = { code: "source_sequence_too_far", message: "Too far." } as const;
    const second = makeController({ assessMergePreflight: async () => [sequence, problem] });
    await expectFail(
      second.controller.transactions("testnet", body()),
      422,
      "source_sequence_too_far",
      "Too far."
    );
  });

  test("T12 an unusable transfer destination is reported with every problem", async () => {
    const problems = [
      { asset: USDC, destination: DEST, code: "destination_missing", message: "first" },
      { asset: USDC, destination: DEST, code: "destination_lacks_trustline", message: "second" },
    ] as const;
    const { controller } = makeController({
      validateTransferDestinations: async () => [...problems],
    });
    await expectFail(
      controller.transactions("testnet", body()),
      422,
      "transfer_destination_unusable",
      "first",
      { problems }
    );
  });

  test("T12b the transfer check reads destinations through the trustline-only reader", async () => {
    const reads: unknown[][] = [];
    const found = { address: DEST, trustlines: [] };
    const { controller } = makeController({
      readTrustlinesOnly: (async (...args: unknown[]) => {
        reads.push(args);
        return found;
      }) as unknown as TrustlineReader,
      validateTransferDestinations: async (_d, _t, _s, _n, readAccount) => {
        expect(await readAccount(DEST, "testnet")).toEqual(found);
        return [];
      },
    });
    await controller.transactions("testnet", body());
    expect(reads).toEqual([[DEST, "testnet"]]);
  });

  test("T13 a ready close returns the plan hash, the transactions and what remains", async () => {
    const calls: unknown[][] = [];
    const { controller } = makeController({
      buildCloseTransactions: (async (...args: unknown[]) => {
        calls.push(args);
        return {
          transactions: TX,
          requiresAnotherCall: true,
          remainingSteps: 2,
        };
      }) as unknown as Builder,
    });
    const decisions = [ACK];
    const result = await controller.transactions("testnet", body({ decisions, memo: "note" }));
    expect(result).toEqual({
      planHash: computePlanHash({
        source: SOURCE,
        destination: DEST,
        decisions,
        snapshotLedger: 77,
      }),
      status: "ready",
      transactions: TX,
      remaining: { steps: 2, requiresAnotherCall: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(1, 5)).toEqual([DEST, {}, "testnet", "note"]);
  });

  test("T14 an HttpException from a collaborator passes through unchanged", async () => {
    const { controller } = makeController({
      readAccountState: async () => {
        throw new HttpException({ error: { code: "x", message: "y" } }, 418);
      },
    });
    await expectFail(controller.transactions("testnet", body()), 418, "x", "y");
  });

  test("T15 a domain error is rethrown for the filter to map", async () => {
    const error = new AccountNotFoundError(SOURCE);
    const { controller } = makeController({
      readAccountState: async () => {
        throw error;
      },
    });
    await expect(controller.transactions("testnet", body())).rejects.toBe(error);
  });

  test("T16 a build refusal keeps its own code, message and status", async () => {
    const { controller } = makeController({
      buildCloseTransactions: async () => {
        throw new CloseBuildError("defi_positions_stale", "stale", 422);
      },
    });
    await expectFail(
      controller.transactions("testnet", body()),
      422,
      "defi_positions_stale",
      "stale"
    );
    const other = makeController({
      buildCloseTransactions: async () => {
        throw new CloseBuildError("quote_drifted", "drifted", 409);
      },
    });
    await expectFail(
      other.controller.transactions("testnet", body()),
      409,
      "quote_drifted",
      "drifted"
    );
  });

  test("T17 an unexpected failure becomes a plain transactions_failed 500", async () => {
    const { controller } = makeController({
      buildCloseTransactions: async () => {
        throw new Error("secret internals");
      },
    });
    await expectFail(
      controller.transactions("testnet", body()),
      500,
      "transactions_failed",
      "Failed to build the close transactions."
    );
  });
});

describe("submit", () => {
  function signed(): string {
    const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
      .setTimeout(30)
      .build();
    return tx.toXDR();
  }

  const failing = (error: unknown) =>
    makeController({
      submitAndWait: async () => {
        throw error;
      },
    }).controller;

  test("U1 a missing or empty envelope is refused", async () => {
    const { controller } = makeController();
    const message = "A signed transaction envelope (signedXdr) is required.";
    await expectFail(controller.submit("testnet", {}), 400, "invalid_signed_xdr", message);
    await expectFail(controller.submit("testnet", { signedXdr: "" }), 400, "invalid_signed_xdr");
    await expectFail(controller.submit("testnet", { signedXdr: 4 }), 400, "invalid_signed_xdr");
  });

  test("U2 a confirmed submission returns its hash and ledger", async () => {
    const { controller } = makeController({
      submitAndWait: async () => ({ txHash: HASH, ledger: 9 }),
    });
    expect(await controller.submit("testnet", { signedXdr: signed() })).toEqual({
      status: "success",
      hash: HASH,
      ledger: 9,
    });
  });

  test("U3 a missing signature is a plain 400", async () => {
    await expectFail(
      failing(new InvalidSignatureError("bad")).submit("testnet", { signedXdr: signed() }),
      400,
      "invalid_signature",
      "The transaction is missing a valid signature."
    );
  });

  test("U4 a confirmation timeout is a 504", async () => {
    await expectFail(
      failing(new TxTimeoutError()).submit("testnet", { signedXdr: signed() }),
      504,
      "confirmation_timeout",
      "The transaction did not confirm in time."
    );
  });

  test("U5 a network rejection surfaces its reason and result code", async () => {
    await expectFail(
      failing(new TxSubmitError("Insufficient balance.", "tx_insufficient_balance")).submit(
        "testnet",
        { signedXdr: signed() }
      ),
      502,
      "submit_rejected",
      "Insufficient balance.",
      { resultCode: "tx_insufficient_balance" }
    );
    const bare = await failing(new TxSubmitError("Rejected.", null))
      .submit("testnet", {
        signedXdr: signed(),
      })
      .then(
        () => null,
        (e: unknown) => e as HttpException
      );
    expect((bare!.getResponse() as { error: Record<string, unknown> }).error).toEqual({
      code: "submit_rejected",
      message: "Rejected.",
    });
  });

  test("U6 an undecodable envelope is a plain 400", async () => {
    await expectFail(
      failing(new InvalidXdrError()).submit("testnet", { signedXdr: signed() }),
      400,
      "invalid_signed_xdr",
      "The transaction envelope could not be decoded."
    );
  });

  test("U7 an unexpected failure becomes a plain submit_failed 502", async () => {
    await expectFail(
      failing(new Error("secret internals")).submit("testnet", { signedXdr: signed() }),
      502,
      "submit_failed",
      "Failed to submit the transaction."
    );
  });

  test("U8 an HttpException passes through unchanged", async () => {
    await expectFail(
      failing(new HttpException({ error: { code: "x", message: "y" } }, 418)).submit("testnet", {
        signedXdr: signed(),
      }),
      418,
      "x",
      "y"
    );
  });

  test("U9 a merge is counted after it confirms and a counter failure never fails the close", async () => {
    const counted: Array<[string, string]> = [];
    const { controller } = makeController({
      submitAndWait: async () => ({ txHash: HASH, ledger: 9 }),
      record: async (network, hash) => {
        counted.push([network, hash]);
        throw new Error("store down");
      },
    });
    const mergeXdr = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .setTimeout(30)
      .build()
      .toXDR();
    expect(await controller.submit("testnet", { signedXdr: mergeXdr })).toEqual({
      status: "success",
      hash: HASH,
      ledger: 9,
    });
    expect(counted).toEqual([["testnet", HASH]]);
  });
});
