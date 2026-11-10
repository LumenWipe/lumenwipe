import { describe, expect, test } from "bun:test";
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ReserveState } from "@/lib/horizon-submit";
import {
  drainAmountStroops,
  executeMessStep,
  feeFloorStroops,
  SMALLEST_CLOSE_FEE_STROOPS,
  type MessContext,
} from "@/lib/mess-builders";
import { CLOSE_FEE_PER_OPERATION_STROOPS } from "@/lib/fee-policy";
import { networkStroops } from "@/lib/stroops";
import { resolvePlan, type MessStepDef } from "@/lib/scenarios";

// The drain that makes the sponsored close necessary: it leaves the demo less than the fee of the
// smallest close transaction above its fee floor, read live, so the API cannot have it pay its own.

const demo = Keypair.random();
const mm = Keypair.random().publicKey();

const STATE: ReserveState = {
  balanceStroops: BigInt(215_000_000),
  sellingLiabilitiesStroops: BigInt(0),
  subentryCount: 3,
  numSponsoring: 0,
  numSponsored: 0,
  baseReserveStroops: BigInt(5_000_000),
  baseFeeStroops: BigInt(100),
};

const ctx: MessContext = {
  demo,
  ephemeralIssuers: new Map(),
  persistentIssuer: Keypair.random(),
  mmPublic: mm,
  transferRecipient: null,
  helpers: new Map(),
  recordSigner: async () => {},
  recordClaimableBalances: async () => {},
  allowances: [],
  recordAllowance: async () => {},
};

const DRAIN: MessStepDef = resolvePlan({
  scenarios: [
    { id: "data-entries", params: { count: 3 } },
    { id: "fee-bump", params: {} },
  ],
}).steps.find((s) => s.id === "DRAIN_TO_FEE_FLOOR")!;

/** Runs the drain against `state`, capturing the transaction instead of sending it. */
async function drain(state: ReserveState): Promise<Transaction> {
  const sent: Transaction[] = [];
  await executeMessStep(DRAIN, ctx, {
    loadAccount: async () => ({ sequenceNumber: () => "100" }),
    reserveState: async () => state,
    submit: async (xdr) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      sent.push(tx);
      return { txHash: "h" };
    },
  });
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

/** What the account has above its fee floor once the drain and its fee are taken. */
function spareAfter(state: ReserveState, tx: Transaction): bigint {
  const [op] = tx.operations;
  if (op?.type !== "payment") throw new Error("expected a payment");
  return state.balanceStroops - BigInt(tx.fee) - networkStroops(op.amount) - feeFloorStroops(state);
}

describe("the drain to the fee floor", () => {
  test("is the last step of the plan", () => {
    const plan = resolvePlan({
      scenarios: [
        { id: "data-entries", params: { count: 2 } },
        { id: "forgotten-signer", params: {} },
        { id: "fee-bump", params: {} },
      ],
    });
    expect(plan.steps[plan.steps.length - 1]?.id).toBe("DRAIN_TO_FEE_FLOOR");
  });

  test("the smallest close transaction is one operation at the API's fee", () => {
    expect(SMALLEST_CLOSE_FEE_STROOPS).toBe(CLOSE_FEE_PER_OPERATION_STROOPS);
  });

  test("leaves the demo strictly less than the smallest close fee above its floor", async () => {
    const tx = await drain(STATE);
    const [op] = tx.operations;
    expect(op).toEqual(expect.objectContaining({ type: "payment", destination: mm }));
    expect(tx.source).toBe(demo.publicKey());
    const spare = spareAfter(STATE, tx);
    expect(spare).toBeGreaterThanOrEqual(BigInt(0));
    expect(spare).toBeLessThan(SMALLEST_CLOSE_FEE_STROOPS);
    expect(spare).toBe(SMALLEST_CLOSE_FEE_STROOPS - BigInt(1));
  });

  test("bids exactly the ledger's base fee, so the fee charged is known in advance", async () => {
    for (const baseFeeStroops of [BigInt(100), BigInt(250)]) {
      const tx = await drain({ ...STATE, baseFeeStroops });
      expect(BigInt(tx.fee)).toBe(baseFeeStroops);
      expect(spareAfter({ ...STATE, baseFeeStroops }, tx)).toBe(
        SMALLEST_CLOSE_FEE_STROOPS - BigInt(1)
      );
    }
  });

  test("the floor counts every entry, sponsorship and offer's XLM, at the live base reserve", async () => {
    const state: ReserveState = {
      ...STATE,
      sellingLiabilitiesStroops: BigInt(30_000_000),
      subentryCount: 4,
      numSponsoring: 2,
      numSponsored: 1,
      baseReserveStroops: BigInt(4_000_000),
    };
    expect(feeFloorStroops(state)).toBe(BigInt(7) * BigInt(4_000_000) + BigInt(30_000_000));
    expect(spareAfter(state, await drain(state))).toBe(SMALLEST_CLOSE_FEE_STROOPS - BigInt(1));
  });

  test("with nothing above the floor to drain, nothing is sent", async () => {
    const floor = feeFloorStroops(STATE);
    const state = { ...STATE, balanceStroops: floor + STATE.baseFeeStroops + BigInt(99) };
    expect(drainAmountStroops(state)).toBe(BigInt(0));
    await expect(drain(state)).rejects.toThrow(/nothing above its fee floor/);
  });
});
