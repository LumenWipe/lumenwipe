import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { HttpException } from "@nestjs/common";
import type { AccountState } from "@lumenwipe/types";
import registryJson from "@/config/exchange-registry.json";
import { CloseController } from "@/close/close.controller";
import {
  assessMergePreflight,
  DestinationReadError,
  remainingTransactionBound,
  sequenceLimit,
  type MergePreflightDeps,
} from "@/lib/close-api/merge-preflight";
import { mapDomainError, PLAN_ERRORS, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { DESTINATION_ACK_CHOICE, destinationDecisionId } from "@/lib/close-api/decisions";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import * as readAccountModule from "@/lib/close-api/read-account";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const EXCHANGE = registryJson.entries[0]!.address;
const LEDGER = 1000;
const LIMIT = sequenceLimit(LEDGER);

function state(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [],
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

const withData = (count: number): Pick<AccountState, "dataEntries"> => ({
  dataEntries: Array.from({ length: count }, (_, i) => ({ key: `k${i}`, value: "" })),
});

function deps(over: Partial<MergePreflightDeps> = {}): MergePreflightDeps & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    accountExists: async (address) => {
      reads.push(address);
      return true;
    },
    latestLedger: async () => LEDGER,
    mediator: () => "",
    feeAccount: () => null,
    ...over,
  };
}

const seq = (n: bigint): string => (LIMIT + n).toString();

afterEach(() => {
  mock.restore();
});

describe("sequence headroom", () => {
  test("one transaction: exactly at the limit is refused, one below passes", async () => {
    const at = await assessMergePreflight(state({ sequence: seq(-1n) }), DEST, "testnet", deps());
    expect(at.map((p) => p.code)).toEqual(["source_sequence_too_far"]);
    const below = await assessMergePreflight(
      state({ sequence: seq(-2n) }),
      DEST,
      "testnet",
      deps()
    );
    expect(below).toEqual([]);
  });

  test("a sequence already beyond the limit is refused", async () => {
    const p = await assessMergePreflight(state({ sequence: seq(5n) }), DEST, "testnet", deps());
    expect(p.map((x) => x.code)).toEqual(["source_sequence_too_far"]);
  });

  test("a multi-round close reserves one number per transaction before the merge", async () => {
    const big = withData(150);
    expect(remainingTransactionBound(state(big), false)).toBe(2);
    const at = await assessMergePreflight(
      state({ ...big, sequence: seq(-2n) }),
      DEST,
      "testnet",
      deps()
    );
    expect(at.map((p) => p.code)).toEqual(["source_sequence_too_far"]);
    const below = await assessMergePreflight(
      state({ ...big, sequence: seq(-3n) }),
      DEST,
      "testnet",
      deps()
    );
    expect(below).toEqual([]);
  });

  test("an exchange close reserves the extra mediator transaction", async () => {
    expect(remainingTransactionBound(state(), true)).toBe(
      remainingTransactionBound(state(), false) + 1
    );
    const at = await assessMergePreflight(
      state({ sequence: seq(-2n) }),
      EXCHANGE,
      "testnet",
      deps()
    );
    expect(at.map((p) => p.code)).toEqual(["source_sequence_too_far"]);
    const below = await assessMergePreflight(
      state({ sequence: seq(-3n) }),
      EXCHANGE,
      "testnet",
      deps()
    );
    expect(below).toEqual([]);
  });

  test("the message explains the condition and does not tell the user to retry", async () => {
    const [p] = await assessMergePreflight(state({ sequence: seq(0n) }), DEST, "testnet", deps());
    expect(p!.message).toContain("too far ahead");
    expect(p!.message).toContain("Retrying does not help");
    expect(p!.message.length).toBeLessThanOrEqual(240);
  });
});

describe("destination", () => {
  test("a healthy account and a funded destination raise nothing", async () => {
    const d = deps();
    expect(await assessMergePreflight(state(), DEST, "testnet", d)).toEqual([]);
    expect(d.reads).toEqual([DEST]);
  });

  test("a registry exchange is never read and never refused", async () => {
    const d = deps({
      accountExists: async () => {
        throw new Error("must not be read");
      },
    });
    expect(await assessMergePreflight(state(), EXCHANGE, "testnet", d)).toEqual([]);
  });

  test("no destination (a plan without one) checks only the sequence", async () => {
    const d = deps();
    expect(await assessMergePreflight(state(), null, "testnet", d)).toEqual([]);
    expect(d.reads).toEqual([]);
  });

  test("the destination being the source is refused without a read", async () => {
    const d = deps();
    const p = await assessMergePreflight(state(), SOURCE, "testnet", d);
    expect(p.map((x) => x.code)).toEqual(["destination_is_source"]);
    expect(d.reads).toEqual([]);
  });

  test("the mediator and the fee account are refused without a read", async () => {
    const mediator = Keypair.random().publicKey();
    const fee = Keypair.random().publicKey();
    const d = deps({ mediator: () => mediator, feeAccount: () => fee });
    expect(
      (await assessMergePreflight(state(), mediator, "testnet", d)).map((x) => x.code)
    ).toEqual(["destination_is_mediator"]);
    expect((await assessMergePreflight(state(), fee, "testnet", d)).map((x) => x.code)).toEqual([
      "destination_is_fee_account",
    ]);
    expect(d.reads).toEqual([]);
  });

  test("an unfunded destination is refused", async () => {
    const p = await assessMergePreflight(
      state(),
      DEST,
      "testnet",
      deps({ accountExists: async () => false })
    );
    expect(p.map((x) => x.code)).toEqual(["destination_missing"]);
  });

  test("a failed read throws a retryable error instead of reporting the destination missing", async () => {
    const promise = assessMergePreflight(
      state(),
      DEST,
      "testnet",
      deps({
        accountExists: async () => {
          throw new Error("horizon 500");
        },
      })
    );
    await expect(promise).rejects.toBeInstanceOf(DestinationReadError);
    for (const table of [PLAN_ERRORS, TRANSACTION_ERRORS]) {
      expect(mapDomainError(table, await promise.catch((e) => e))).toMatchObject({
        code: "destination_read_failed",
        status: 503,
      });
    }
  });

  test("every refusal message reads as plain language", async () => {
    const mediator = Keypair.random().publicKey();
    const fee = Keypair.random().publicKey();
    const d = deps({
      mediator: () => mediator,
      feeAccount: () => fee,
      accountExists: async () => false,
    });
    const all = [
      ...(await assessMergePreflight(state(), SOURCE, "testnet", d)),
      ...(await assessMergePreflight(state(), mediator, "testnet", d)),
      ...(await assessMergePreflight(state(), fee, "testnet", d)),
      ...(await assessMergePreflight(state(), DEST, "testnet", d)),
    ];
    expect(all).toHaveLength(4);
    for (const p of all) {
      expect(p.message.length).toBeLessThanOrEqual(240);
      expect(p.message).not.toMatch(/\b(tx|op)_[a-z_]+\b|Error|\(\d{3}\)/);
    }
  });
});

describe("POST close/transactions", () => {
  function controller(): CloseController {
    return new CloseController({ record: async () => undefined } as never);
  }

  function arrange(destination: string, opts: { exists: boolean | Error }): void {
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(state());
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getLatestLedger: () => Promise.resolve({ sequence: LEDGER }),
    })) as unknown as typeof rpcModule.getRpcServer);
    spyOn(accountStateModule, "readTrustlinesOnly").mockImplementation(async () => {
      if (opts.exists instanceof Error) throw opts.exists;
      return opts.exists ? { address: destination, trustlines: [] } : null;
    });
  }

  function request(destination: string): Promise<unknown> {
    return controller().transactions("testnet", {
      source: SOURCE,
      destination,
      decisions: [{ id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE }],
    });
  }

  async function refusal(
    promise: Promise<unknown>
  ): Promise<{ status: number; error: { code: string } }> {
    const e = await promise.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HttpException);
    const http = e as HttpException;
    return { status: http.getStatus(), ...(http.getResponse() as { error: { code: string } }) };
  }

  test("a destination equal to the source is a 422 with no transactions", async () => {
    arrange(SOURCE, { exists: true });
    const r = await refusal(request(SOURCE));
    expect(r.status).toBe(422);
    expect(r.error.code).toBe("merge_destination_unusable");
  });

  test("an unfunded destination is a 422 with no transactions", async () => {
    arrange(DEST, { exists: false });
    const r = await refusal(request(DEST));
    expect(r.status).toBe(422);
    expect(r.error.code).toBe("merge_destination_unusable");
  });

  test("a sequence at the limit is a 422 with its own code", async () => {
    arrange(DEST, { exists: true });
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(state({ sequence: seq(-1n) }));
    const r = await refusal(request(DEST));
    expect(r.status).toBe(422);
    expect(r.error.code).toBe("source_sequence_too_far");
  });

  test("a failed destination read is a retryable 503, not a missing destination", async () => {
    arrange(DEST, { exists: new Error("horizon 500") });
    const e = await request(DEST).catch((err: unknown) => err);
    expect(mapDomainError(TRANSACTION_ERRORS, e)).toMatchObject({
      code: "destination_read_failed",
      status: 503,
    });
  });
});

describe("POST close/plan", () => {
  function arrange(account: AccountState, exists: boolean): void {
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(account);
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getLatestLedger: () => Promise.resolve({ sequence: LEDGER }),
    })) as unknown as typeof rpcModule.getRpcServer);
    spyOn(accountStateModule, "readTrustlinesOnly").mockImplementation(async () =>
      exists ? { address: DEST, trustlines: [] } : null
    );
  }

  test("a destination equal to the source blocks the plan", async () => {
    arrange(state(), true);
    const plan = await buildAccountPlan(SOURCE, SOURCE, [], "testnet");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.some((b) => b.message.includes("account being closed"))).toBe(true);
  });

  test("an unfunded destination blocks the plan", async () => {
    arrange(state(), false);
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.some((b) => b.message.includes("does not exist"))).toBe(true);
  });

  test("a sequence at the limit blocks the plan with the real explanation", async () => {
    arrange(state({ sequence: seq(-1n) }), true);
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.some((b) => b.message.includes("too far ahead"))).toBe(true);
  });

  test("a healthy account and funded destination add no blocker", async () => {
    arrange(state(), true);
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet");
    expect(plan.blockers).toEqual([]);
  });
});
