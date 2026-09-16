import { test, expect } from "bun:test";
import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { ClaimAnswers } from "@/lib/api/analyze-client";
import { loadAnalysis } from "@/lib/api/analyze-client";

const BALANCE_A = "00000000a1";
const BALANCE_B = "00000000b2";

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
  await expect(analysis).resolves.toMatchObject({ replanned: false });
});

test("the plan built in parallel is kept when applying the account leaves the claim answers alone", async () => {
  const answers: ClaimAnswers = { [BALANCE_A]: "forfeit" };
  const planCalls: ClaimAnswers[] = [];

  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState([BALANCE_A])),
    fetchPlan: (sent) => {
      planCalls.push(sent);
      return Promise.resolve(planFor(sent));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {},
  });

  expect(planCalls).toEqual([{ [BALANCE_A]: "forfeit" }]);
  expect(result).not.toBeNull();
  expect(result?.plan.planHash).toBe(BALANCE_A);
  expect(result?.replanned).toBe(false);
});

test("a plan built on answers the account state prunes away is discarded and rebuilt", async () => {
  // The account no longer holds balance A, so applying it drops that answer. The plan already
  // in flight was asked for WITH it, and answers a question no longer being asked.
  let answers: ClaimAnswers = { [BALANCE_A]: "forfeit", [BALANCE_B]: "claim" };
  const planCalls: ClaimAnswers[] = [];

  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState([BALANCE_B])),
    fetchPlan: (sent) => {
      planCalls.push({ ...sent });
      return Promise.resolve(planFor(sent));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {
      answers = { [BALANCE_B]: "claim" };
    },
  });

  expect(planCalls).toHaveLength(2);
  expect(planCalls[1]).toEqual({ [BALANCE_B]: "claim" });
  expect(result?.plan.planHash).toBe(BALANCE_B);
  expect(result?.replanned).toBe(true);
});

test("the account's failure is what surfaces, even when the plan failed first", async () => {
  // The plan rejects BEFORE the account does, on purpose: an implementation that simply raced
  // the two (Promise.all) would surface "plan blew up" here. The account is what the page
  // cannot render without, so its message is the one the user must get.
  const analysis = loadAnalysis({
    fetchAccount: async () => {
      await tick();
      throw new Error("account is gone");
    },
    fetchPlan: () => Promise.reject(new Error("plan blew up")),
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => ({}),
    applyAccount: () => {},
  });

  await expect(analysis).rejects.toThrow("account is gone");
});

test("a failed rebuild surfaces its own error rather than the discarded plan's", async () => {
  let answers: ClaimAnswers = { [BALANCE_A]: "forfeit" };
  let call = 0;

  const analysis = loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState([BALANCE_B])),
    fetchPlan: () => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("stale plan blew up"))
        : Promise.reject(new Error("rebuilt plan blew up"));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {
      answers = {};
    },
  });

  await expect(analysis).rejects.toThrow("rebuilt plan blew up");
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
  expect(result?.account.claimableBalances).toEqual([]);
});

test("a request the page has already superseded does not pay for a rebuilt plan", async () => {
  // Answering a second claim card starts a newer fetch while this one is still in flight. Its
  // result is discarded either way, so rebuilding the plan for it is a wasted close/plan build -
  // the single most expensive call the page makes.
  let answers: ClaimAnswers = { [BALANCE_A]: "forfeit" };
  const planCalls: ClaimAnswers[] = [];

  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState([BALANCE_B])),
    fetchPlan: (sent) => {
      planCalls.push({ ...sent });
      return Promise.resolve(planFor(sent));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {
      answers = {};
    },
    abandoned: () => true,
  });

  expect(result).toBeNull();
  expect(planCalls).toHaveLength(1);
});

test("a live request still rebuilds the plan when the answers were pruned", async () => {
  let answers: ClaimAnswers = { [BALANCE_A]: "forfeit" };
  const planCalls: ClaimAnswers[] = [];

  const result = await loadAnalysis({
    fetchAccount: () => Promise.resolve(accountState([BALANCE_B])),
    fetchPlan: (sent) => {
      planCalls.push({ ...sent });
      return Promise.resolve(planFor(sent));
    },
    loadRegistry: () => Promise.resolve(undefined),
    readAnswers: () => answers,
    applyAccount: () => {
      answers = {};
    },
    abandoned: () => false,
  });

  expect(planCalls).toHaveLength(2);
  expect(result?.replanned).toBe(true);
});
