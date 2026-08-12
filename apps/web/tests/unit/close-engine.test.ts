import { test, expect } from "bun:test";
import { runClose, InsufficientSignatureWeightError } from "@/lib/api/close-engine";
import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/sdk";

function tx(order: number, id = `tx${order}`): CloseTransaction {
  return { id, order, xdr: `xdr-${id}` } as unknown as CloseTransaction;
}

function resp(
  transactions: CloseTransaction[],
  requiresAnotherCall: boolean
): TransactionsResponse {
  return {
    planHash: "h",
    status: "ready",
    transactions,
    remaining: { steps: requiresAnotherCall ? 1 : 0, requiresAnotherCall },
  } as TransactionsResponse;
}

test("runClose › signs+submits all txs in order across rounds, then stops", async () => {
  const rounds = [resp([tx(1), tx(0)], true), resp([tx(2)], false)];
  let i = 0;
  const submitted: number[] = [];
  await runClose({
    getTransactions: async () => rounds[i++],
    verify: () => {},
    requiredWeight: () => 1,
    sign: async (t, xdr) => ({ xdr, weight: 1 }),
    submit: async (t) => {
      submitted.push(t.order);
      return `hash-${t.order}`;
    },
  });
  expect(submitted).toEqual([0, 1, 2]);
  expect(i).toBe(2);
});

test("runClose › verify then sign then submit, in that order, for each tx", async () => {
  const calls: string[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: (t) => {
      calls.push(`verify:${t.order}`);
    },
    requiredWeight: () => 1,
    sign: async (t, xdr) => {
      calls.push(`sign:${t.order}`);
      return { xdr, weight: 1 };
    },
    submit: async (t) => {
      calls.push(`submit:${t.order}`);
      return "h";
    },
  });
  expect(calls).toEqual(["verify:0", "sign:0", "submit:0"]);
});

test("runClose › a failed verification aborts before anything is signed", async () => {
  const signed: number[] = [];
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0), tx(1)], false),
      verify: (t) => {
        if (t.order === 0) throw new Error("merge to attacker");
      },
      requiredWeight: () => 1,
      sign: async (t, xdr) => {
        signed.push(t.order);
        return { xdr, weight: 1 };
      },
      submit: async () => "h",
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toBe("merge to attacker");
  expect(signed).toEqual([]);
});

test("runClose › weight exactly meeting the requirement submits (boundary, not just exceeding)", async () => {
  const submitted: number[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: () => {},
    requiredWeight: () => 2,
    sign: async (t, xdr) => ({ xdr, weight: 2 }),
    submit: async (t) => {
      submitted.push(t.order);
      return "h";
    },
  });
  expect(submitted).toEqual([0]);
});

test("runClose › insufficient weight throws instead of submitting", async () => {
  const submitted: number[] = [];
  let err: unknown = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], false),
      verify: () => {},
      requiredWeight: () => 2,
      sign: async (t, xdr) => ({ xdr, weight: 1 }),
      submit: async (t) => {
        submitted.push(t.order);
        return "h";
      },
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(InsufficientSignatureWeightError);
  const weightErr = err as InsufficientSignatureWeightError;
  expect(weightErr.accumulatedWeight).toBe(1);
  expect(weightErr.requiredWeight).toBe(2);
  expect(weightErr.tx.order).toBe(0);
  expect(submitted).toEqual([]); // never submitted an under-signed transaction
});

test("runClose › bounded rounds - never loops forever", async () => {
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], true),
      verify: () => {},
      requiredWeight: () => 1,
      sign: async (t, xdr) => ({ xdr, weight: 1 }),
      submit: async () => "h",
      maxRounds: 3,
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toMatch(/did not converge/);
});
