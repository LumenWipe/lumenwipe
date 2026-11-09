import { afterEach, describe, expect, test } from "bun:test";
import {
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  AccountBusyError,
  MM_SESSION_FLOOR_XLM,
  callFriendbot,
  faucetOutcome,
  spendableXlm,
  topUpMarketMaker,
  withAccountLock,
} from "@/lib/market-maker";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import { selectionForMode } from "@/lib/mess-plan";
import { resolvePlan } from "@/lib/scenarios";
import { MM_KEEP_XLM } from "@/lib/standing-liquidity";
import { memoryStore } from "./session-fixtures";

// Fake network only: Friendbot and Horizon are stubbed, and every key is Keypair.random().

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(answer: (url: string) => Promise<Response>): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      urls.push(String(input));
      return answer(String(input));
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  return urls;
}

describe("market maker balance", () => {
  test("spendable XLM excludes what its offers have committed and what it keeps", () => {
    expect(spendableXlm({ balance: "10000.0000000", sellingLiabilities: "3000.0000000" })).toBe(
      7000 - MM_KEEP_XLM
    );
    expect(spendableXlm({ balance: "600.0000000", sellingLiabilities: "0" })).toBe(
      600 - MM_KEEP_XLM
    );
    expect(MM_SESSION_FLOOR_XLM).toBeGreaterThan(0);
  });
});

describe("faucet", () => {
  test("a rate limit and an outage are told apart", async () => {
    expect(faucetOutcome(200)).toBe("funded");
    expect(faucetOutcome(429)).toBe("rate_limited");
    for (const status of [500, 502, 503, 504, 400])
      expect(faucetOutcome(status)).toBe("unavailable");

    stubFetch(async () => new Response("slow down", { status: 429 }));
    expect(await callFriendbot(Keypair.random().publicKey())).toBe("rate_limited");
    stubFetch(async () => new Response("bad gateway", { status: 502 }));
    expect(await callFriendbot(Keypair.random().publicKey())).toBe("unavailable");
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await callFriendbot(Keypair.random().publicKey())).toBe("unavailable");
  });

  test("the address is sent encoded to Friendbot", async () => {
    const urls = stubFetch(async () => new Response("{}", { status: 200 }));
    const address = Keypair.random().publicKey();
    expect(await callFriendbot(address)).toBe("funded");
    expect(urls).toEqual([`https://friendbot.stellar.org/?addr=${address}`]);
  });
});

describe("top-up", () => {
  const mm = Keypair.random().publicKey();

  test("a funded throwaway is merged into the market maker and the failure record cleared", async () => {
    const store = memoryStore();
    await store.recordFaucetFailure("rate_limited");
    const funded: string[] = [];
    const merged: [string, string][] = [];
    const result = await topUpMarketMaker({
      store,
      mmPublic: mm,
      faucet: async (publicKey) => {
        funded.push(publicKey);
        return "funded";
      },
      merge: async (source, destination) => void merged.push([source.publicKey(), destination]),
    });
    expect(result).toBe("funded");
    expect(merged).toEqual([[funded[0]!, mm]]);
    expect(await store.lastFaucetFailure()).toBeNull();
  });

  test("a faucet refusal is recorded for the session copy and nothing is merged", async () => {
    for (const failure of ["rate_limited", "unavailable"] as const) {
      const store = memoryStore();
      let merges = 0;
      const result = await topUpMarketMaker({
        store,
        mmPublic: mm,
        faucet: async () => failure,
        merge: async () => void merges++,
      });
      expect(result).toBe(failure);
      expect(merges).toBe(0);
      expect(await store.lastFaucetFailure()).toBe(failure);
    }
  });

  test("a failed merge logs the throwaway's public key only, and the faucet is not asked again", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
    let faucetCalls = 0;
    let throwaway: Keypair | null = null;
    try {
      const result = await topUpMarketMaker({
        store: memoryStore(),
        mmPublic: mm,
        faucet: async () => {
          faucetCalls++;
          return "funded";
        },
        merge: async (source) => {
          throwaway = source;
          throw new Error(`op_underfunded for ${source.secret()}`);
        },
      });
      expect(result).toBe("merge_failed");
    } finally {
      console.error = original;
    }
    expect(faucetCalls).toBe(1);
    const kp = throwaway as Keypair | null;
    if (!kp) throw new Error("merge was not attempted");
    const text = logged.join("\n");
    expect(text).toContain(kp.publicKey());
    expect(text).toContain("merge_failed");
    expect(text).not.toContain(kp.secret());
  });
});

describe("account lock", () => {
  test("submissions from one account run one at a time; other accounts are not held up", async () => {
    const store = memoryStore();
    const account = Keypair.random().publicKey();
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const job = (name: string) => async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${name}`);
      inFlight--;
      return name;
    };
    const results = await Promise.all(
      ["a", "b", "c"].map((name) => withAccountLock(store, account, job(name), { pollMs: 1 }))
    );
    expect(results).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.slice(6)).toBe(order[i + 1]!.slice(4));
    }

    const other = Keypair.random().publicKey();
    const lease = await store.acquireLease(`account:${account}`, 60_000);
    expect(await withAccountLock(store, other, async () => "free", { waitMs: 0 })).toBe("free");
    await store.releaseLease(lease!);
  });

  test("a holder that never lets go makes the next caller give up, not wait forever", async () => {
    const store = memoryStore();
    const account = Keypair.random().publicKey();
    await store.acquireLease(`account:${account}`, 60_000);
    let ran = false;
    let t = 0;
    await expect(
      withAccountLock(store, account, async () => void (ran = true), {
        waitMs: 100,
        pollMs: 10,
        now: () => t,
        sleep: async (ms) => void (t += ms),
      })
    ).rejects.toBeInstanceOf(AccountBusyError);
    expect(ran).toBe(false);
  });

  test("the lease is released after a failed submission", async () => {
    const store = memoryStore();
    const account = Keypair.random().publicKey();
    await expect(
      withAccountLock(store, account, async () => {
        throw new Error("tx_bad_seq");
      })
    ).rejects.toThrow("tx_bad_seq");
    expect(await withAccountLock(store, account, async () => "next", { waitMs: 0 })).toBe("next");
  });
});

describe("setup step", () => {
  const plan = resolvePlan(selectionForMode("standard"));
  const step = plan.steps.find((s) => s.action.kind === "setup")!;
  if (step.action.kind !== "setup") throw new Error("expected a setup step");
  const funding = step.action.fundingXlm;

  async function runSetup(balance: string): Promise<Transaction> {
    const demo = Keypair.random();
    const ctx: MessContext = {
      demo,
      ephemeralIssuers: new Map(plan.ephemeralAssets.map((code) => [code, Keypair.random()])),
      persistentIssuer: Keypair.random(),
      mmPublic: Keypair.random().publicKey(),
      transferRecipient: null,
      helpers: new Map(),
      recordSigner: async () => {},
      recordClaimableBalances: async () => {},
    };
    let posted: Transaction | null = null;
    const reads: string[] = [];
    await executeMessStep(step, ctx, {
      loadAccount: async () => ({ sequenceNumber: () => "1" }),
      loadNativeBalance: async (address) => {
        reads.push(address);
        return { balance, sellingLiabilities: "0" };
      },
      submit: async (xdr) => {
        const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
        if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
        posted = tx;
        return { txHash: "h" };
      },
      sleep: async () => {},
    });
    expect(reads).toEqual([demo.publicKey()]);
    if (!posted) throw new Error("nothing was submitted");
    return posted;
  }

  const payments = (tx: Transaction) =>
    tx.operations.filter((op): op is Operation.Payment => op.type === "payment");

  test("the return to the market maker is computed from the balance read, not a constant", async () => {
    const extra = await runSetup((Number(funding) + 12.3456789).toFixed(7));
    expect(payments(extra).map((p) => p.amount)).toEqual(["12.3456789"]);

    const other = await runSetup((Number(funding) + 1).toFixed(7));
    expect(payments(other).map((p) => p.amount)).toEqual(["1.0000000"]);
  });

  test("a demo holding exactly its funding returns nothing and only creates its issuers", async () => {
    const tx = await runSetup(funding);
    expect(payments(tx)).toEqual([]);
    expect(tx.operations.map((op) => op.type)).toEqual(
      plan.ephemeralAssets.map(() => "createAccount")
    );
  });
});
