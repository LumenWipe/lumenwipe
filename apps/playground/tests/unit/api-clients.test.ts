import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { LumenWipeApiError, type FetchLike } from "@lumenwipe/sdk";
import { READ_RETRY_ROUTE_BUDGET_MS, readClient } from "@/lib/api-clients";
import { SESSION_LOCK_TTL_MS } from "@/lib/session-store";
import * as stateRoute from "@/app/api/session/[id]/state/route";
import * as batchPlanRoute from "@/app/api/batch/[id]/plan/route";

const ADDRESS = Keypair.random().publicKey();

function busy(retryAfter: string): Response {
  return Response.json(
    { error: { code: "service_unavailable", message: "busy" } },
    { status: 503, headers: { "Retry-After": retryAfter } }
  );
}

/** Answers each request in turn, the last answer repeating, and counts them. */
function answering(...answers: (() => Response)[]): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => answers[Math.min(n++, answers.length - 1)](),
    calls: () => n,
  };
}

describe("the read client", () => {
  test("an account read answered busy once is made again and returns the account", async () => {
    const api = answering(
      () => busy("0"),
      () => Response.json({ address: ADDRESS })
    );
    const account = await readClient("https://api.test", "key", api.fetch).getAccount(ADDRESS);
    expect(account.address).toBe(ADDRESS);
    expect(api.calls()).toBe(2);
  });

  test("a batch plan answered busy once is asked for again", async () => {
    const api = answering(
      () => busy("0"),
      () => Response.json({ results: [] })
    );
    const plan = await readClient("https://api.test", "key", api.fetch).batchPlan({
      addresses: [ADDRESS],
      destination: ADDRESS,
    } as never);
    expect(plan).toEqual({ results: [] } as never);
    expect(api.calls()).toBe(2);
  });

  test("a second busy answer is thrown after one retry", async () => {
    const api = answering(() => busy("0"));
    const read = readClient("https://api.test", "key", api.fetch).getAccount(ADDRESS);
    await expect(read).rejects.toBeInstanceOf(LumenWipeApiError);
    expect(api.calls()).toBe(2);
  });
});

describe("the routes that read through it", () => {
  test.each([
    ["session state", stateRoute.maxDuration],
    ["batch plan", batchPlanRoute.maxDuration],
  ])("the %s route outlasts two reads and the wait, inside the session lock", (_, seconds) => {
    expect(seconds * 1000).toBeGreaterThanOrEqual(READ_RETRY_ROUTE_BUDGET_MS);
    expect(seconds * 1000).toBeLessThan(SESSION_LOCK_TTL_MS);
  });
});
