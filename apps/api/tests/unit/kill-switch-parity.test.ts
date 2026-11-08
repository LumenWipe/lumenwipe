import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { AccountState, DefiPosition } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { killSwitchBlockers } from "@/lib/kill-switches/blockers";
import { ALL_ON, type KillSwitches } from "@/config/kill-switches";
import type { ExitRunResult } from "@/lib/defi-exits";
import { DEGRADED_SOURCE_CONFIRMED } from "@/lib/defi-positions/resolve-defi-positions";
import { stroopsToFixedXlm } from "@/lib/utils/amounts";
import * as rpcModule from "@/lib/stellar/rpc";
import * as registry from "@/lib/exchange-registry";
import * as networks from "@/config/networks";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MEDIATOR = Keypair.random().publicKey();
const TOKEN = Address.contract(Buffer.alloc(32, 7)).toString();
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_ASSET = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const ONE_XLM = 10_000_000n;
const HALF_XLM = 5_000_000n;
const COSIGNER = Keypair.random().publicKey();
const NO_SPONSOR: KillSwitches = { ...ALL_ON, feeSponsorConfigured: false };

function state(balanceStroops: bigint, over: Partial<AccountState> = {}): AccountState {
  return {
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
}

const blendSupply: DefiPosition = {
  protocol: "blend",
  positionType: "supply",
  contractAddress: POOL,
  assetAddress: POOL_ASSET,
  bTokenAmount: "1",
  usdValue: null,
};

function withPosition(): AccountState {
  return state(100n * ONE_XLM, {
    defiPositions: {
      ...emptyDefiPositionsResult(SOURCE),
      source: DEGRADED_SOURCE_CONFIRMED,
      timestamp: null,
      positions: [blendSupply],
    },
  });
}

function withToken(): AccountState {
  return state(100n * ONE_XLM, {
    sorobanTokens: {
      tokens: [{ contract: TOKEN, balance: "250", symbol: "XTAR", decimals: 7, sources: [] }],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
  });
}

/** At its minimum balance, so it has nothing above the reserve to pay a fee with. */
function atMinimum(): AccountState {
  return state(ONE_XLM);
}

/** No single key reaches the thresholds, so signer normalization is its own first round. */
function multisigAtMinimum(): AccountState {
  return state(ONE_XLM + HALF_XLM, {
    signers: [
      { key: SOURCE, weight: 1, type: "ed25519_public_key" },
      { key: COSIGNER, weight: 1, type: "ed25519_public_key" },
    ],
    thresholds: { low: 2, med: 2, high: 2 },
    numSubEntries: 1,
  });
}

/** A data entry, so an exchange close has a cleanup round ahead of the relay merge. */
function withDataAtMinimum(): AccountState {
  return state(ONE_XLM + HALF_XLM, {
    dataEntries: [{ key: "k", value: "dg==" }],
    numSubEntries: 1,
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
  const op = Operation.invokeContractFunction({ contract: POOL, function: "submit", args: [] });
  const txXdr = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
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
      build: { source: "local", op },
      intent: { contract: POOL, function: "submit", args: [], minReceived: [], recipient: SOURCE },
      simulation: { minResourceFee: "1", latestLedger: 1, txXdr },
    },
    blockers: [],
  } as unknown as ExitRunResult;
}

interface Case {
  name: string;
  switches: KillSwitches;
  account: () => AccountState;
  exchange: boolean;
  dispositions: Record<string, "convert">;
  provider?: "soroswap" | "xbull";
  code: string;
  status: number;
}

const CASES: Case[] = [
  {
    name: "the relay account forward is paused",
    switches: { ...ALL_ON, mediatorForward: false },
    account: () => state(10n * ONE_XLM),
    exchange: true,
    dispositions: {},
    code: "exchange_forward_paused",
    status: 503,
  },
  {
    name: "the relay account is not configured",
    switches: { ...ALL_ON, mediatorConfigured: false },
    account: () => state(10n * ONE_XLM),
    exchange: true,
    dispositions: {},
    code: "mediator_not_configured",
    status: 503,
  },
  {
    name: "fee sponsorship is paused and the account cannot pay its own fees",
    switches: { ...ALL_ON, feeSponsorship: false },
    account: () => state(ONE_XLM),
    exchange: false,
    dispositions: {},
    code: "fee_sponsorship_paused",
    status: 503,
  },
  {
    name: "no fee sponsor is configured and a classic close cannot pay its own fees",
    switches: NO_SPONSOR,
    account: atMinimum,
    exchange: false,
    dispositions: {},
    code: "close_fee_balance_short",
    status: 422,
  },
  {
    name: "no fee sponsor is configured and signer normalization comes first",
    switches: NO_SPONSOR,
    account: multisigAtMinimum,
    exchange: false,
    dispositions: {},
    code: "close_fee_balance_short",
    status: 422,
  },
  {
    name: "no fee sponsor is configured and an exchange close has cleanup ahead",
    switches: NO_SPONSOR,
    account: withDataAtMinimum,
    exchange: true,
    dispositions: {},
    code: "close_fee_balance_short",
    status: 422,
  },
  {
    name: "the protocol's exits are paused",
    switches: { ...ALL_ON, pausedExits: new Set(["blend"]) },
    account: withPosition,
    exchange: false,
    dispositions: {},
    code: "defi_exit_paused",
    status: 503,
  },
  {
    name: "conversion through the provider the answer accepted is paused",
    switches: { ...ALL_ON, xbullConversion: false },
    account: withToken,
    exchange: false,
    dispositions: { [TOKEN]: "convert" },
    provider: "xbull",
    code: "soroban_token_conversion_unavailable",
    status: 422,
  },
  {
    name: "Soroban conversion is paused for an answer that names no provider",
    switches: { ...ALL_ON, sorobanConversion: false },
    account: withToken,
    exchange: false,
    dispositions: { [TOKEN]: "convert" },
    code: "soroban_token_conversion_unavailable",
    status: 422,
  },
];

let rpcReads = 0;

beforeEach(() => {
  rpcReads = 0;
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(rpcModule, "getRpcServer").mockImplementation(((): unknown => {
    rpcReads++;
    return {
      getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
      getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
      getLedgerEntries: mirrorSnapshot(SOURCE, () => []),
    };
  }) as unknown as typeof rpcModule.getRpcServer);
  spyOn(rpcModule, "pinRpcProvider").mockImplementation((async () => {
    rpcReads++;
  }) as unknown as typeof rpcModule.pinRpcProvider);
  spyOn(networks, "getMediatorPublicKey").mockReturnValue(MEDIATOR);
});

afterEach(() => mock.restore());

function plan(c: Case, switches: KillSwitches) {
  const account = c.account();
  return buildPlan(
    switches,
    account,
    c.exchange,
    false,
    {},
    undefined,
    c.dispositions,
    {},
    account.defiPositions,
    false,
    undefined,
    c.provider ? { [TOKEN]: c.provider } : {}
  );
}

function build(c: Case, switches: KillSwitches) {
  spyOn(registry, "requiresMediatorForAddress").mockReturnValue(c.exchange);
  return buildCloseTransactions(
    switches,
    c.account(),
    DEST,
    c.dispositions,
    "testnet",
    null,
    {},
    {},
    { runExitAdapter: async () => oneStepExit() },
    {},
    c.provider ? { floors: { [TOKEN]: { minAmountOut: "1", provider: c.provider } } } : {}
  );
}

async function refusal(promise: Promise<unknown>): Promise<CloseBuildError> {
  const failure = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(CloseBuildError);
  return failure as CloseBuildError;
}

describe.each(CASES)("when $name", (c) => {
  test("the plan and the build report the same blocker", async () => {
    const codes = plan(c, c.switches).blockers.map((b) => b.code);
    expect(codes).toContain(c.code);

    const failure = await refusal(build(c, c.switches));
    expect(failure.code as string).toBe(c.code);
    expect(failure.status).toBe(c.status);
    const blocker = plan(c, c.switches).blockers.find((b) => b.code === c.code)!;
    expect(failure.message).toBe(blocker.message);
  });

  test("nothing is read or built before the refusal", async () => {
    await refusal(build(c, c.switches));
    expect(rpcReads).toBe(0);
  });

  test("with every switch on, neither reports it", () => {
    expect(plan(c, ALL_ON).blockers.map((b) => b.code)).not.toContain(c.code);
    expect(
      killSwitchBlockers(c.account(), ALL_ON, {
        viaMediator: c.exchange,
        dispositions: c.dispositions,
        conversionProviders: {},
        claimableBalanceSelections: {},
      })
    ).toEqual([]);
  });

  test("the copy is plain language: no code, no variable name", () => {
    const blocker = plan(c, c.switches).blockers.find((b) => b.code === c.code)!;
    expect(blocker.message).not.toContain(c.code);
    expect(blocker.message).not.toMatch(/_ENABLED|operator|[a-z]+_[a-z]+/);
  });
});

describe("a switch flipped between rounds of one close", () => {
  test("an exchange close whose cleanup landed builds the merge, then refuses it once the forward is off", async () => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(true);
    const call = (switches: KillSwitches) =>
      buildCloseTransactions(switches, state(10n * ONE_XLM), DEST, {}, "testnet");

    const on = await call(ALL_ON);
    const ops = TransactionBuilder.fromXDR(on.transactions[0]!.xdr, Networks.TESTNET).operations;
    expect(ops.map((o) => o.type)).toEqual(["accountMerge", "payment"]);

    const off = await refusal(call({ ...ALL_ON, mediatorForward: false }));
    expect(off.code).toBe("exchange_forward_paused");
  });

  test("an exchange close with cleanup ahead is refused before the cleanup round", async () => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(true);
    const withData = state(10n * ONE_XLM, {
      dataEntries: [{ key: "k", value: "dg==" }],
      numSubEntries: 1,
    });
    const off = await refusal(
      buildCloseTransactions({ ...ALL_ON, mediatorForward: false }, withData, DEST, {}, "testnet")
    );
    expect(off.code).toBe("exchange_forward_paused");
    expect(rpcReads).toBe(0);
  });

  test("a close that needs the fee sponsor is built sponsored, then refused once sponsorship is off", async () => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(false);
    const call = (switches: KillSwitches) =>
      buildCloseTransactions(switches, state(ONE_XLM), DEST, {}, "testnet");

    const on = await call(ALL_ON);
    expect(on.transactions[0]!.needsSponsoredFee).toBe(true);

    const off = await refusal(call({ ...ALL_ON, feeSponsorship: false }));
    expect(off.code).toBe("fee_sponsorship_paused");
  });

  test("a paused protocol's exit is built while on and refused once paused", async () => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(false);
    const call = (switches: KillSwitches) =>
      buildCloseTransactions(
        switches,
        withPosition(),
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

    const on = await call(ALL_ON);
    expect(on.transactions[0]!.covers).toEqual(["EXIT_POSITIONS"]);

    const off = await refusal(call({ ...ALL_ON, pausedExits: new Set(["blend"]) }));
    expect(off.code).toBe("defi_exit_paused");
  });
});

describe("the plan for a paused protocol", () => {
  test("offers no exit step for it", () => {
    const account = withPosition();
    const paused = buildPlan(
      { ...ALL_ON, pausedExits: new Set(["blend"]) },
      account,
      false,
      false,
      {},
      undefined,
      {},
      {},
      account.defiPositions
    );
    expect(paused.steps.some((s) => s.type === "EXIT_POSITIONS")).toBe(false);

    const open = buildPlan(
      ALL_ON,
      account,
      false,
      false,
      {},
      undefined,
      {},
      {},
      account.defiPositions
    );
    expect(open.steps.some((s) => s.type === "EXIT_POSITIONS")).toBe(true);
  });

  test("another protocol being paused leaves its exit alone", () => {
    const account = withPosition();
    const result = buildPlan(
      { ...ALL_ON, pausedExits: new Set(["aquarius"]) },
      account,
      false,
      false,
      {},
      undefined,
      {},
      {},
      account.defiPositions
    );
    expect(result.blockers.map((b) => b.code)).not.toContain("defi_exit_paused");
    expect(result.steps.some((s) => s.type === "EXIT_POSITIONS")).toBe(true);
  });
});

describe("fee sponsorship paused", () => {
  test("an account that can pay its own fees is not blocked", () => {
    const blockers = killSwitchBlockers(
      state(2n * ONE_XLM),
      { ...ALL_ON, feeSponsorship: false },
      {
        viaMediator: false,
        dispositions: {},
        conversionProviders: {},
        claimableBalanceSelections: {},
      }
    );
    expect(blockers).toEqual([]);
  });

  test("names the XLM the account is short of", () => {
    const [blocker] = killSwitchBlockers(
      state(ONE_XLM),
      { ...ALL_ON, feeSponsorship: false },
      {
        viaMediator: false,
        dispositions: {},
        conversionProviders: {},
        claimableBalanceSelections: {},
      }
    );
    expect(blocker!.message).toContain("0.0000200 XLM");
  });
});

describe("no fee sponsor configured for the network", () => {
  test("not configured takes precedence over paused", () => {
    const codes = killSwitchBlockers(
      atMinimum(),
      { ...NO_SPONSOR, feeSponsorship: false },
      {
        viaMediator: false,
        dispositions: {},
        conversionProviders: {},
        claimableBalanceSelections: {},
      }
    ).map((b) => b.code);
    expect(codes).toEqual(["close_fee_balance_short"]);
  });

  test("an account that can pay its own fees is not blocked", () => {
    expect(
      killSwitchBlockers(state(2n * ONE_XLM), NO_SPONSOR, {
        viaMediator: false,
        dispositions: {},
        conversionProviders: {},
        claimableBalanceSelections: {},
      })
    ).toEqual([]);
  });

  test("a close with Soroban rounds ahead keeps the plan's own Soroban shortfall", () => {
    const account = withPosition();
    const short = { ...account, nativeBalanceLumens: stroopsToFixedXlm(ONE_XLM) };
    const blockers = buildPlan(
      NO_SPONSOR,
      short,
      false,
      false,
      {},
      undefined,
      {},
      {},
      short.defiPositions
    ).blockers.filter((b) => b.code === "close_fee_balance_short");
    expect(blockers).toHaveLength(1);
  });
});

describe("a fee sponsor configured for the network", () => {
  test.each([
    ["a classic close", atMinimum],
    ["a signer normalization first", multisigAtMinimum],
  ] as const)("leaves the plan unchanged and sponsors the fee, for %s", async (_, account) => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(false);
    const codes = buildPlan(ALL_ON, account(), false, false, {}, undefined, {}, {}).blockers.map(
      (b) => b.code
    );
    expect(codes).not.toContain("close_fee_balance_short");
    const built = await buildCloseTransactions(ALL_ON, account(), DEST, {}, "testnet");
    expect(built.transactions[0]!.needsSponsoredFee).toBe(true);
  });
});
