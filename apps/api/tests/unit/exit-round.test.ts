import { describe, expect, test } from "bun:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import type { AccountState, BlendBorrowPosition, BlendSupplyPosition } from "@lumenwipe/types";
import type { ExitRunResult, ExitStep } from "@/lib/defi-exits";
import { buildExitRound, ExitRoundBlockedError } from "@/lib/defi-exits/exit-round";
import { fakeExitRpc } from "./fixtures/fake-exit-adapter";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const POOL_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

function supply(contract: string): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: contract,
    assetAddress: USDC,
    bTokenAmount: "1",
    usdValue: null,
  };
}
function borrow(contract: string): BlendBorrowPosition {
  return {
    protocol: "blend",
    positionType: "borrow",
    contractAddress: contract,
    assetAddress: USDC,
    dTokenAmount: "1",
    usdValue: null,
  };
}

function account(positions: AccountState["defiPositions"]["positions"]): AccountState {
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
    defiPositions: { ...emptyDefiPositionsResult(SOURCE), positions },
    defiPositionsWarnings: [],
  };
}

/** A real one-operation Soroban envelope, so the round's intent decoding runs on real bytes. */
function exitTx(contract: string, fn: string): string {
  return new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract,
        function: fn,
        args: [new Address(SOURCE).toScVal(), nativeToScVal(5n, { type: "i128" })],
      })
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

function step(kind: ExitStep["kind"], contract: string): ExitStep {
  return {
    kind,
    contract,
    function: "submit",
    asset: USDC,
    amount: "5",
    ceiling: "5",
    minReceived: [],
    description: `${kind} in ${contract.slice(0, 4)}`,
  };
}

function built(plan: ExitStep[], contract: string): ExitRunResult {
  const first = plan[0]!;
  return {
    contract,
    resolution: {
      status: "known",
      protocol: "blend",
      kind: "pool",
      version: "v2",
      wasmHash: "a".repeat(64),
    },
    plan,
    next: {
      step: first,
      build: {
        source: "local",
        op: Operation.invokeContractFunction({ contract, function: "submit", args: [] }),
      },
      intent: { contract, function: "submit", args: [], minReceived: [], recipient: SOURCE },
      simulation: { minResourceFee: "1", latestLedger: 1, txXdr: exitTx(contract, "submit") },
    },
    blockers: [],
  };
}

function blocked(contract: string, code: string): ExitRunResult {
  return {
    contract,
    resolution: null,
    plan: [],
    next: null,
    blockers: [{ code, message: `blocked: ${code}` }],
  };
}

const rpc = fakeExitRpc({ liveWasmHash: null, liveBalance: "0" });

describe("buildExitRound", () => {
  test("no positions, no round", async () => {
    expect(await buildExitRound(account([]), "testnet", "100", 1000, { rpc })).toBeNull();
  });

  test("builds the first step of the first target as a single transaction with a decoded intent", async () => {
    const calls: string[] = [];
    const round = await buildExitRound(
      account([supply(POOL), borrow(POOL)]),
      "testnet",
      "100",
      1000,
      {
        rpc,
        runExitAdapter: async (_adapter, position) => {
          calls.push(position.contractAddress);
          return built([step("repay", POOL), step("withdraw", POOL)], POOL);
        },
      }
    );
    if (!round) throw new Error("expected a round");
    expect(calls).toEqual([POOL]); // once per pool, not once per position
    expect(round.transaction.covers).toEqual(["EXIT_POSITIONS"]);
    expect(round.transaction.sourceSequence).toBe("100");
    expect(round.transaction.intent.summary).toBe("repay in CCEB");
    expect(round.transaction.intent.operations).toHaveLength(1);
    const op = round.transaction.intent.operations[0]!;
    if (op.type !== "invoke_host_function") throw new Error("expected an invocation intent");
    expect(op.contract).toBe(POOL);
    expect(op.function).toBe("submit");
    expect(op.accountsReferenced).toEqual([SOURCE]);
    // One step built now; one more in this pool's plan.
    expect(round.remainingSteps).toBe(1);
  });

  test("hands the adapter the account's token balances and the live sequence", async () => {
    let seen: { balances: Record<string, string>; sequence: string } | null = null;
    await buildExitRound(
      { ...account([supply(POOL)]), nativeBalanceLumens: "7.0000000" },
      "testnet",
      "4242",
      1000,
      {
        rpc,
        runExitAdapter: async (_adapter, _position, ctx) => {
          seen = { balances: ctx.tokenBalances, sequence: ctx.sequence };
          return built([step("withdraw", POOL)], POOL);
        },
      }
    );
    expect(seen!.sequence).toBe("4242");
    // Spendable, not nominal: 7 XLM less the 1 XLM base reserve and the exit fee margin.
    expect(Object.values(seen!.balances)).toContain("59900000");
  });

  test("a target already gone (exited on a previous round) is skipped, the next one builds", async () => {
    // POOL_2 (CAAA…) sorts first and is gone; POOL (CCEB…) still has a position to exit.
    const round = await buildExitRound(
      account([supply(POOL), supply(POOL_2)]),
      "testnet",
      "100",
      1000,
      {
        rpc,
        runExitAdapter: async (_adapter, position) =>
          position.contractAddress === POOL
            ? built([step("withdraw", POOL)], POOL)
            : blocked(POOL_2, "exit_position_gone"),
      }
    );
    if (!round) throw new Error("expected a round");
    expect(round.transaction.intent.operations[0]).toMatchObject({
      type: "invoke_host_function",
      contract: POOL,
    });
    expect(round.remainingSteps).toBe(0);
  });

  test("every target gone means nothing left to exit", async () => {
    const round = await buildExitRound(account([supply(POOL)]), "testnet", "100", 1000, {
      rpc,
      runExitAdapter: async () => blocked(POOL, "exit_position_gone"),
    });
    expect(round).toBeNull();
  });

  test("any other blocker refuses the build with the adapter's own code", async () => {
    await expect(
      buildExitRound(account([borrow(POOL)]), "testnet", "100", 1000, {
        rpc,
        runExitAdapter: async () => blocked(POOL, "blend_repay_asset_missing"),
      })
    ).rejects.toThrow(ExitRoundBlockedError);
    await expect(
      buildExitRound(account([borrow(POOL)]), "testnet", "100", 1000, {
        rpc,
        runExitAdapter: async () => blocked(POOL, "blend_repay_asset_missing"),
      })
    ).rejects.toMatchObject({ code: "blend_repay_asset_missing" });
  });

  test("a protocol without an adapter refuses as unsupported before running anything", async () => {
    let ran = false;
    const promise = buildExitRound(
      account([
        {
          protocol: "soroswap",
          positionType: "lp",
          contractAddress: POOL,
          shareAmount: "1",
          usdValue: null,
        },
      ]),
      "testnet",
      "100",
      1000,
      {
        rpc,
        runExitAdapter: async () => {
          ran = true;
          return blocked(POOL, "x");
        },
      }
    );
    await expect(promise).rejects.toMatchObject({ code: "defi_exit_unsupported" });
    expect(ran).toBe(false);
  });

  test("a pool holding a position the adapter cannot take refuses whole, before running anything", async () => {
    let ran = false;
    const promise = buildExitRound(
      account([supply(POOL), { ...supply(POOL), isBackstop: true }]),
      "testnet",
      "100",
      1000,
      {
        rpc,
        runExitAdapter: async () => {
          ran = true;
          return blocked(POOL, "x");
        },
      }
    );
    await expect(promise).rejects.toMatchObject({ code: "defi_exit_unsupported" });
    expect(ran).toBe(false);
  });

  test("remaining steps count the rest of this pool and every other target", async () => {
    const round = await buildExitRound(
      account([supply(POOL), supply(POOL_2)]),
      "testnet",
      "100",
      1000,
      {
        rpc,
        runExitAdapter: async (_adapter, position) =>
          built(
            [step("repay", position.contractAddress), step("withdraw", position.contractAddress)],
            position.contractAddress
          ),
      }
    );
    // POOL_2 sorts before POOL (CAAA < CCEB): its 2 steps minus the one built, plus POOL's target.
    expect(round?.transaction.intent.operations[0]).toMatchObject({ contract: POOL_2 });
    expect(round?.remainingSteps).toBe(2);
  });
});
