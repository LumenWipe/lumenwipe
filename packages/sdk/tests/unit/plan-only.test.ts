import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { LumenWipeApiError, LumenWipeClient, type FetchLike, type Network } from "../../src/index";
import { describeError } from "../../examples/support";
import { BLOCKED_EXIT_CODE, runPlanOnly } from "../../examples/plan-only";

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();

const account = { address: source, numSubEntries: 3, nativeBalanceLumens: "12.5" };
const plan = (blockers: unknown[] = []) => ({
  planHash: "plan-1",
  status: blockers.length ? "blocked" : "ready",
  decisionPoints: [{ id: `destination:${destination}`, required: true }],
  blockers,
  execution: { estimatedTransactionCount: 2, transactions: [] },
});

function api(planBody: unknown, status = 200): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }), {
        status,
        headers: { "X-Request-Id": "req-9" },
      });
    }
    const body = url.includes("/close/plan") ? planBody : account;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike, network: Network) =>
  new LumenWipeClient({ baseUrl: "https://api.example.com", apiKey: "k", network, fetch });

let build: ReturnType<typeof spyOn>;
let sign: ReturnType<typeof spyOn>;
beforeEach(() => {
  build = spyOn(TransactionBuilder.prototype, "build");
  sign = spyOn(Transaction.prototype, "sign");
});
afterEach(() => {
  build.mockRestore();
  sign.mockRestore();
});

describe("plan-only rehearsal", () => {
  for (const network of ["testnet", "mainnet"] as const) {
    test(`reads the account and plans on ${network}, and nothing else`, async () => {
      const { fetch, calls } = api(plan());
      const lines: string[] = [];
      const code = await runPlanOnly(
        client(fetch, network),
        { source, destination, network },
        (l) => lines.push(l)
      );
      expect(code).toBe(0);
      expect(calls).toEqual([
        `GET /v1/${network}/account/${source}`,
        `POST /v1/${network}/close/plan`,
      ]);
      expect(build).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(lines).toContain("No blockers.");
      expect(lines.join("\n")).toContain(`Decisions to answer: destination:${destination}`);
    });
  }

  test("prints each blocker and exits with the blocked code", async () => {
    const { fetch } = api(
      plan([
        { code: "liquidity_pool_share", message: "Withdraw first.", helpUrl: "https://x.test" },
      ])
    );
    const lines: string[] = [];
    const code = await runPlanOnly(
      client(fetch, "testnet"),
      { source, destination, network: "testnet" },
      (l) => lines.push(l)
    );
    expect(code).toBe(BLOCKED_EXIT_CODE);
    expect(lines).toContain("  liquidity_pool_share: Withdraw first. (https://x.test)");
    expect(build).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  test("a rejected key surfaces as a typed error", async () => {
    const { fetch, calls } = api(plan(), 401);
    const error = await runPlanOnly(client(fetch, "testnet"), {
      source,
      destination,
      network: "testnet",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LumenWipeApiError);
    expect(calls).toHaveLength(1);
    const out = describeError(error).join("\n");
    expect(out).toContain("  status: 401\n  code: unauthorized");
    expect(out).toContain("requestId: req-9");
  });
});
