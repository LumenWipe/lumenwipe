import { test, expect } from "bun:test";
import { runClose } from "@/lib/api/close-engine";
import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/sdk";

function tx(order: number, id = `tx${order}`): CloseTransaction {
  return { id, order, xdr: `xdr-${id}` } as unknown as CloseTransaction;
}

function resp(transactions: CloseTransaction[], requiresAnotherCall: boolean): TransactionsResponse {
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
  const signed: number[] = [];
  await runClose({
    getTransactions: async () => rounds[i++],
    verify: () => {},
    signAndSubmit: async (t) => {
      signed.push(t.order);
      return `hash-${t.order}`;
    },
  });
  expect(signed).toEqual([0, 1, 2]); // sorted by order within round 1, then round 2
  expect(i).toBe(2); // stopped after the round with requiresAnotherCall=false
});

test("runClose › verify runs before signAndSubmit for each tx", async () => {
  const calls: string[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: (t) => {
      calls.push(`verify:${t.order}`);
    },
    signAndSubmit: async (t) => {
      calls.push(`submit:${t.order}`);
      return "h";
    },
  });
  expect(calls).toEqual(["verify:0", "submit:0"]);
});

test("runClose › a failed verification aborts before anything is signed", async () => {
  const submitted: number[] = [];
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0), tx(1)], false),
      verify: (t) => {
        if (t.order === 0) throw new Error("merge to attacker");
      },
      signAndSubmit: async (t) => {
        submitted.push(t.order);
        return "h";
      },
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toBe("merge to attacker");
  expect(submitted).toEqual([]); // nothing signed or submitted
});

test("runClose › an async verification that rejects aborts before signing", async () => {
  const submitted: number[] = [];
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], false),
      // async verifier that rejects — the engine must await it and not sign.
      verify: async () => {
        throw new Error("async verify rejected");
      },
      signAndSubmit: async (t) => {
        submitted.push(t.order);
        return "h";
      },
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toBe("async verify rejected");
  expect(submitted).toEqual([]); // nothing signed or submitted
});

test("runClose › bounded rounds — never loops forever", async () => {
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], true), // always asks for another round
      verify: () => {},
      signAndSubmit: async () => "h",
      maxRounds: 3,
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toMatch(/did not converge/);
});
