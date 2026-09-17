import { test, expect } from "bun:test";
import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { ClaimAnswers } from "@/lib/api/analyze-client";
import { loadAnalysis } from "@/lib/api/analyze-client";

const BALANCE_A = "00000000a1";

function accountState(claimableBalanceIds: string[] = []): AccountState {
  return {
    address: "GBXIT5W7J7BWYPAZUPFV3RHDVGD5EKIIHKTSYOL5GSADD3YGMIHPLNQX",
    claimableBalances: claimableBalanceIds.map((id) => ({
      id,
      asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      amount: "1.0000000",
      claimable: true,
      forfeited: false,
    })),
  } as unknown as AccountState;
}

const planFor = (answers: ClaimAnswers): PlanResponse =>
  ({ planHash: Object.keys(answers).sort().join("+") || "no-answers" }) as unknown as PlanResponse;

/** A promise a test resolves by hand, so "did both requests start?" is observable. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("the account read and the plan build are in flight at the same time", async () => {
  const account = deferred<AccountState>();
  const plan = deferred<PlanResponse>();
  let planStarted = false;

  const analysis = loadAnalysis({
    fetchAccount: () => account.promise,
    fetchPlan: () => {
      planStarted = true;
      return plan.promise;
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  await tick();
  // The plan was asked for while the account read had not answered yet - the whole point.
  expect(planStarted).toBe(true);

  account.resolve(accountState());
  plan.resolve(planFor({}));
  await expect(analysis).resolves.toMatchObject({ plan: { planHash: "no-answers" } });
});

test("the plan is asked for with the claim answers held when the analysis starts", async () => {
  // Not the ones left after applying the account: the API resolves claim answers against its own
  // live read and skips any balance it does not hold, so waiting for the store's prune would buy
  // nothing but a second round trip.
  const account = deferred<AccountState>();
  const planCalls: ClaimAnswers[] = [];
  let answers: ClaimAnswers = { [BALANCE_A]: "forfeit" };

  const analysis = loadAnalysis({
    fetchAccount: () => account.promise,
    fetchPlan: (sent) => {
      planCalls.push({ ...sent });
      return Promise.resolve(planFor(sent));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {
      // The account no longer holds that balance, so the store drops the answer.
      answers = {};
    },
  });

  account.resolve(accountState());
  await analysis;
  expect(planCalls).toEqual([{ [BALANCE_A]: "forfeit" }]);
});

test("the account's failure is what surfaces, even when the plan failed first", async () => {
  // The plan rejects BEFORE the account does, on purpose: an implementation that simply raced
  // the two (Promise.all) would surface "plan blew up" here. The account is what the page
  // cannot render without, so its message is the one the user must get.
  let planStarted = false;
  const analysis = loadAnalysis({
    fetchAccount: async () => {
      await tick();
      throw new Error("account is gone");
    },
    fetchPlan: () => {
      planStarted = true;
      return Promise.reject(new Error("plan blew up"));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  await expect(analysis).rejects.toThrow("account is gone");
  // The plan was started even though the account read went on to fail - it cannot be conditional
  // on an answer that has not arrived yet.
  expect(planStarted).toBe(true);
});

test("a plan failure still surfaces when the account read succeeded", async () => {
  const analysis = loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState()),
    fetchPlan: () => Promise.reject(new Error("plan blew up")),
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  await expect(analysis).rejects.toThrow("plan blew up");
});

test("a registry that fails to refresh does not fail the analysis", async () => {
  // The real loader degrades to its bundled floor rather than rejecting; a rejection here must
  // not take down an analysis that otherwise succeeded, nor mask the account's own error.
  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState()),
    fetchPlan: () => Promise.resolve(planFor({})),
    loadRegistry: () => Promise.reject(new Error("registry is down")),
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  expect(result.plan.planHash).toBe("no-answers");
});

test("the account is published, and the registry loaded, before the analysis is handed back", async () => {
  const order: string[] = [];
  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState()),
    fetchPlan: () => Promise.resolve(planFor({})),
    loadRegistry: async () => {
      await tick();
      order.push("registry");
    },
    readAnswers: () => ({}),
    applyAccount: () => order.push("account"),
  });

  expect(order).toEqual(["account", "registry"]);
  expect(result.account.claimableBalances).toEqual([]);
});

test("a token the first plan could not have known about triggers exactly one re-plan, naming it", async () => {
  // The account read and the plan run at once, so the first plan is asked for before anyone
  // knows what the account holds - and the close round has no token scan of its own. Without the
  // second ask, the page shows a balance with no card to decide on.
  const TOKEN = "CCHATUHI32FTTTMTEYHP2UII73XGUXZ5JTNN6OBQMD3PFLSNVPTOIN54";
  const asked: Array<readonly string[] | undefined> = [];
  const result = await loadAnalysis({
    fetchAccount: async () =>
      ({
        ...accountState(),
        sorobanTokens: { tokens: [{ contract: TOKEN, balance: "1", symbol: "POL", decimals: 7 }] },
      }) as never,
    fetchPlan: async (_answers, tokens) => {
      asked.push(tokens);
      return asked.length === 1
        ? ({ planHash: "before", decisionPoints: [] } as never)
        : ({
            planHash: "after",
            decisionPoints: [{ subject: { kind: "soroban_token", contract: TOKEN } }],
          } as never);
    },
    loadRegistry: async () => undefined,
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  expect(asked).toEqual([undefined, [TOKEN]]);
  expect(result.plan.planHash).toBe("after");
});

test("a plan that already covers the account's tokens is not asked for twice", async () => {
  const TOKEN = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";
  let calls = 0;
  await loadAnalysis({
    fetchAccount: async () =>
      ({
        ...accountState(),
        sorobanTokens: { tokens: [{ contract: TOKEN, balance: "5", symbol: "XTAR", decimals: 7 }] },
      }) as never,
    fetchPlan: async () => {
      calls++;
      return {
        planHash: "covered",
        decisionPoints: [{ subject: { kind: "soroban_token", contract: TOKEN } }],
      } as never;
    },
    loadRegistry: async () => undefined,
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  // Anything on a bundled list, or paid out by a detected position, is already in the first
  // plan: re-asking would cost a round trip for nothing.
  expect(calls).toBe(1);
});
