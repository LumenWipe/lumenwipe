import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  AccountState,
  BlendSupplyPosition,
  DecisionAnswer,
  PlannedStep,
} from "@lumenwipe/types";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import {
  DESTINATION_ACK_CHOICE,
  destinationDecisionId,
  LEAVE_POSITION_CHOICE,
  leavePositionDecisionId,
  positionsLeftBehind,
} from "@/lib/close-api/decisions";
import { CloseService } from "@/close/close.service";
import {
  defaultClock,
  defaultCloseBuilder,
  defaultCloseReader,
  defaultExchangeRegistry,
  defaultRpcServerFactory,
  submitterFor,
} from "@/common/ports";
import type { ExitTargetBlock } from "@/lib/defi-exits/plan-exits";
import type { ExitRunResult } from "@/lib/defi-exits";
import * as readAccountModule from "@/lib/close-api/read-account";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const OTHER_ACCOUNT = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const POOL_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

function supply(contract: string, usdValue: string | null = "25.00"): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: contract,
    assetAddress: USDC,
    bTokenAmount: "1",
    usdValue,
  };
}

function state(positions: BlendSupplyPosition[]): AccountState {
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
    defiPositions: {
      ...emptyDefiPositionsResult(SOURCE),
      timestamp: new Date().toISOString(),
      positions,
    },
    defiPositionsWarnings: [],
  };
}

const simulationFails: ExitTargetBlock = {
  code: "exit_simulation_failed",
  message: "Simulating the withdraw of this Blend position failed on the network.",
  leaveEligible: true,
};

const leave = (contract: string, account = SOURCE): DecisionAnswer => ({
  id: leavePositionDecisionId(account, contract),
  choice: LEAVE_POSITION_CHOICE,
});

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
});
afterEach(() => mock.restore());

describe("positionsLeftBehind", () => {
  test("takes only this account's answers with the leave choice and a real contract", () => {
    const left = positionsLeftBehind(
      [
        leave(POOL),
        leave(POOL_2, OTHER_ACCOUNT),
        { id: leavePositionDecisionId(SOURCE, POOL_2), choice: "acknowledged" },
        { id: `defi_leave:${SOURCE}:not-a-contract`, choice: LEAVE_POSITION_CHOICE },
      ],
      SOURCE
    );
    expect([...left]).toEqual([POOL]);
  });
});

describe("the plan for a position whose exit cannot be built", () => {
  function arrange(account: AccountState): void {
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(account);
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    })) as unknown as typeof rpcModule.getRpcServer);
    spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
      address: DEST,
      trustlines: [],
    } as never);
  }

  const preflight =
    (blocked: Record<string, ExitTargetBlock>) => async (): Promise<Map<string, ExitTargetBlock>> =>
      new Map(Object.entries(blocked));

  test("blocks the merge by name, offers no exit for it, and asks whether to leave it behind", async () => {
    arrange(state([supply(POOL), supply(POOL_2)]));
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet", {
      preflightExits: preflight({ [POOL]: simulationFails }),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((b) => b.code)).toEqual(["exit_simulation_failed"]);
    expect(plan.blockers[0]!.message).toContain("about $25.00");
    expect(
      (plan.steps as PlannedStep[])
        .filter((s) => s.type === "EXIT_POSITIONS")
        .map((s) => s.affectedContract)
    ).toEqual([POOL_2]);
    const point = plan.decisionPoints.find((dp) => dp.id === leavePositionDecisionId(SOURCE, POOL));
    expect(point).toMatchObject({
      type: "confirmation",
      required: true,
      subject: { kind: "defi_position_leave", contract: POOL, usdValue: "25.00" },
      options: [{ id: LEAVE_POSITION_CHOICE }],
    });
    expect(plan.decisionPoints.some((dp) => dp.id.endsWith(POOL_2))).toBe(false);
  });

  test("after the user leaves it behind, only a recorded warning remains", async () => {
    arrange(state([supply(POOL)]));
    const plan = await buildAccountPlan(SOURCE, DEST, [leave(POOL)], "testnet", {
      preflightExits: preflight({ [POOL]: simulationFails }),
    });
    expect(plan.blockers.map((b) => b.code)).toEqual(["defi_position_left_behind"]);
    expect((plan.steps as PlannedStep[]).some((s) => s.type === "EXIT_POSITIONS")).toBe(false);
  });

  test("an answer given for another account leaves nothing behind", async () => {
    arrange(state([supply(POOL)]));
    const plan = await buildAccountPlan(SOURCE, DEST, [leave(POOL, OTHER_ACCOUNT)], "testnet", {
      preflightExits: preflight({ [POOL]: simulationFails }),
    });
    expect(plan.blockers.map((b) => b.code)).toEqual(["exit_simulation_failed"]);
  });

  test("a blocker that may clear on retry is never offered as something to leave, and the round decides", async () => {
    arrange(state([supply(POOL)]));
    const plan = await buildAccountPlan(SOURCE, DEST, [leave(POOL)], "testnet", {
      preflightExits: preflight({
        [POOL]: { code: "exit_read_failed", message: "Retry the analysis.", leaveEligible: false },
      }),
    });
    expect(plan.blockers).toEqual([]);
    expect((plan.steps as PlannedStep[]).map((s) => s.type)).toContain("EXIT_POSITIONS");
    expect(plan.decisionPoints.some((dp) => dp.id.startsWith("defi_leave:"))).toBe(false);
  });

  test("a preflight that fails plans the exit as before, so the round still decides", async () => {
    arrange(state([supply(POOL)]));
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet", {
      preflightExits: async () => {
        throw new Error("rpc down");
      },
    });
    expect(plan.blockers).toEqual([]);
    expect((plan.steps as PlannedStep[]).map((s) => s.type)).toContain("EXIT_POSITIONS");
  });
});

describe("building a close past a position the user left behind", () => {
  function stubRpc(): void {
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
      getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
      getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    })) as unknown as typeof rpcModule.getRpcServer);
  }

  const failingExit = async (): Promise<ExitRunResult> => ({
    contract: POOL,
    resolution: null,
    plan: [],
    next: null,
    blockers: [{ code: "exit_simulation_failed", message: "Simulation failed." }],
    leaveEligible: true,
  });

  test("without the choice, the build refuses before any merge is offered", async () => {
    stubRpc();
    const promise = buildCloseTransactions(
      state([supply(POOL)]),
      DEST,
      {},
      "testnet",
      null,
      {},
      {},
      {
        runExitAdapter: failingExit,
      }
    );
    await expect(promise).rejects.toMatchObject({ code: "defi_exit_blocked", status: 422 });
  });

  test("with the choice, the close goes on to the merge", async () => {
    stubRpc();
    const result = await buildCloseTransactions(
      state([supply(POOL)]),
      DEST,
      {},
      "testnet",
      null,
      {},
      {},
      { runExitAdapter: failingExit, leaveBehind: new Set([POOL]) }
    );
    const merges = result.transactions.flatMap((t) =>
      TransactionBuilder.fromXDR(t.xdr, Networks.TESTNET).operations.filter(
        (op) => op.type === "accountMerge"
      )
    );
    expect(merges).toHaveLength(1);
  });

  test("POST close/transactions hands the user's leave answers to the builder", async () => {
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(state([supply(POOL)]));
    let seen: ReadonlySet<string> | undefined;
    const service = new CloseService(
      { record: async () => undefined } as never,
      defaultCloseReader,
      {
        ...defaultCloseBuilder,
        assessMergePreflight: async () => [],
        buildCloseTransactions: async (...args) => {
          seen = args[7]?.leaveBehind;
          return { transactions: [], requiresAnotherCall: false, remainingSteps: 0 };
        },
      },
      submitterFor(defaultRpcServerFactory),
      defaultExchangeRegistry,
      defaultClock
    );
    await service.transactions("testnet", {
      source: SOURCE,
      destination: DEST,
      decisions: [
        leave(POOL),
        leave(POOL_2, OTHER_ACCOUNT),
        { id: destinationDecisionId(DEST), choice: DESTINATION_ACK_CHOICE },
      ],
    });
    expect(seen ? [...seen] : null).toEqual([POOL]);
  });
});
