import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { planBatch, type BatchPlanDeps } from "@/lib/close-api/batch-plan";
import { AccountNotFoundError, UnusableProviderResponseError } from "@/lib/utils/errors";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import type { PlanResponse } from "@lumenwipe/types";

// `deps.buildAccountPlan` is injected rather than mocked via `mock.module` - see
// account-state.test.ts's header comment for why this codebase avoids that: it is
// process-global in Bun and would leak a stub into every other suite in the run.

function readyPlan(planHash: string): PlanResponse {
  return {
    planHash,
    status: "ready",
    steps: [],
    decisionPoints: [],
    blockers: [],
    estimate: { feeStroops: "0", freedReserveXlm: "0.0000000" },
    execution: { estimatedTransactionCount: 0, transactions: [] },
  };
}

function fakeDeps(behavior: (address: string) => Promise<PlanResponse>): BatchPlanDeps {
  return {
    buildAccountPlan: (source) => behavior(source),
  };
}

describe("planBatch", () => {
  test("plans every address and preserves request order in the result", async () => {
    const addresses = [Keypair.random().publicKey(), Keypair.random().publicKey()];
    const deps = fakeDeps(async (address) => readyPlan(`hash-${address}`));

    const results = await planBatch(addresses, null, "testnet", deps);

    expect(results.map((r) => r.address)).toEqual(addresses);
    expect(results[0]!.plan.planHash).toBe(`hash-${addresses[0]}`);
    expect(results[1]!.plan.planHash).toBe(`hash-${addresses[1]}`);
  });

  test("isolates one address's failure as its own blocked plan, others unaffected (#288)", async () => {
    const good = Keypair.random().publicKey();
    const missing = Keypair.random().publicKey();
    const deps = fakeDeps(async (address) => {
      if (address === missing) throw new AccountNotFoundError(address);
      return readyPlan("ok");
    });

    const results = await planBatch([good, missing], null, "testnet", deps);

    const goodResult = results.find((r) => r.address === good)!;
    expect(goodResult.plan.status).toBe("ready");

    const missingResult = results.find((r) => r.address === missing)!;
    expect(missingResult.plan.status).toBe("blocked");
    expect(missingResult.plan.blockers).toEqual([
      { code: "account_not_found", message: new AccountNotFoundError(missing).message },
    ]);
  });

  test("maps a truncated-collection failure to account_too_large", async () => {
    const address = Keypair.random().publicKey();
    const deps = fakeDeps(async () => {
      throw new TruncatedCollectionError("Too many offers to enumerate safely.");
    });

    const [result] = await planBatch([address], null, "testnet", deps);

    expect(result!.plan.status).toBe("blocked");
    expect(result!.plan.blockers[0]!.code).toBe("account_too_large");
  });

  test("maps an unusable-provider-response failure to provider_response_unusable", async () => {
    const address = Keypair.random().publicKey();
    const deps = fakeDeps(async () => {
      throw new UnusableProviderResponseError(address, ["num_sponsoring"]);
    });

    const [result] = await planBatch([address], null, "testnet", deps);

    expect(result!.plan.status).toBe("blocked");
    expect(result!.plan.blockers[0]!.code).toBe("provider_response_unusable");
  });

  test("falls back to plan_failed for an unrecognized error", async () => {
    const address = Keypair.random().publicKey();
    const deps = fakeDeps(async () => {
      throw new Error("boom");
    });

    const [result] = await planBatch([address], null, "testnet", deps);

    expect(result!.plan.status).toBe("blocked");
    expect(result!.plan.blockers[0]!.code).toBe("plan_failed");
  });

  test("passes the shared destination through to every address", async () => {
    const addresses = [Keypair.random().publicKey(), Keypair.random().publicKey()];
    const destination = Keypair.random().publicKey();
    const seen: (string | null)[] = [];
    const deps: BatchPlanDeps = {
      buildAccountPlan: async (_source, dest) => {
        seen.push(dest);
        return readyPlan("ok");
      },
    };

    await planBatch(addresses, destination, "testnet", deps);

    expect(seen).toEqual([destination, destination]);
  });
});
