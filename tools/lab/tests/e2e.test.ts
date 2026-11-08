import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, CloseEngineDeps, CloseTransaction } from "@lumenwipe/sdk";
import { runE2e, type CloseApi, type E2eDeps } from "../src/e2e";
import { confirmationPhrase } from "../src/guards";
import { LabRefusal } from "../src/home";

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();

interface Calls {
  api: string[];
  horizon: number;
  prompt: number;
  signed: number;
  verified: string[];
  runner: number;
}

function setup(
  overrides: Partial<E2eDeps> = {},
  opts: {
    balances?: readonly (string | null)[];
    ledgerSigners?: { key: string; type: string; weight: number }[];
  } = {}
) {
  const calls: Calls = { api: [], horizon: 0, prompt: 0, signed: 0, verified: [], runner: 0 };
  const balances = opts.balances ?? ["5", null];
  const tx = { id: "close-1", xdr: "AAAA" } as CloseTransaction;
  const api = {
    getAccount: async () => {
      calls.api.push("account");
      return {
        address: source,
        nativeBalanceLumens: "5",
        signers: [{ key: source, type: "ed25519_public_key", weight: 1 }],
        thresholds: { low: 0, med: 0, high: 0 },
      };
    },
    closePlan: async () => {
      calls.api.push("plan");
      return {
        planHash: "plan-hash",
        blockers: [],
        decisionPoints: [{ id: `destination:${destination}`, required: true }],
      };
    },
    closeTransactions: async () => {
      calls.api.push("transactions");
      return { transactions: [tx] };
    },
    submit: async () => {
      calls.api.push("submit");
      return { hash: "h" };
    },
  } as unknown as CloseApi;
  let captured: CloseEngineDeps | undefined;
  const deps: E2eDeps = {
    network: "testnet",
    submit: false,
    destination,
    allowlist: [destination],
    capXlm: "100",
    signer: {
      publicKey: source,
      sign: (xdr) => {
        calls.signed += 1;
        return `${xdr}-signed`;
      },
      hash: () => "hash",
    },
    api,
    horizonAccount: async () => {
      const balance = balances[Math.min(calls.horizon++, balances.length - 1)];
      return balance === null
        ? null
        : {
            nativeBalance: balance,
            signers: opts.ledgerSigners ?? [{ key: source, type: "ed25519_public_key", weight: 1 }],
            thresholds: { low: 0, med: 0, high: 0 },
          };
    },
    verify: (t) => {
      calls.verified.push(t.id);
    },
    prompt: async () => {
      calls.prompt += 1;
      return confirmationPhrase(source);
    },
    isTTY: true,
    closeRunner: async (d) => {
      calls.runner += 1;
      captured = d;
      const round = await d.getTransactions({ planHash: d.planHash });
      for (const t of round.transactions) {
        await d.verify(t);
        const signed = await d.sign(t, t.xdr);
        await d.submit(t, signed.xdr);
        d.onConfirmed?.(t, "h");
      }
      return { status: "done" } as never;
    },
    ...overrides,
  };
  return { deps, calls, captured: () => captured };
}

describe("e2e dry run", () => {
  test("builds and verifies the first round and never signs or submits", async () => {
    const { deps, calls } = setup();
    const report = await runE2e(deps);
    expect(report.submitted).toBe(false);
    expect(calls.api).toEqual(["account", "plan", "transactions"]);
    expect(calls.verified).toEqual(["close-1"]);
    expect(calls.signed).toBe(0);
    expect(calls.runner).toBe(0);
    expect(calls.prompt).toBe(0);
    expect(report.steps.map((s) => s.step)).toEqual(["analyze", "plan", "build round 1"]);
  });
});

describe("e2e refuses before signing", () => {
  const refusals: [string, Partial<E2eDeps>, { balances?: readonly (string | null)[] }?][] = [
    ["a destination off the allowlist", { submit: true, allowlist: [] }],
    ["no destination", { submit: true, destination: undefined }],
    ["a source above the balance cap", { submit: true }, { balances: ["100.0000001"] }],
    ["a source Horizon does not know", { submit: true }, { balances: [null] }],
    ["no terminal", { submit: true, isTTY: false }],
    ["the wrong confirmation", { submit: true, prompt: async () => "CLOSE" }],
    ["no confirmation typed", { submit: true, prompt: async () => null }],
  ];
  for (const [what, overrides, opts] of refusals) {
    test(what, async () => {
      const { deps, calls } = setup(overrides, opts);
      await expect(runE2e(deps)).rejects.toThrow(LabRefusal);
      expect(calls.signed).toBe(0);
      expect(calls.runner).toBe(0);
      expect(calls.api).not.toContain("submit");
    });
  }

  test("checks the allowlist and the cap before calling the API under test", async () => {
    for (const [overrides, opts] of [
      [{ submit: true, allowlist: [] }, {}],
      [{ submit: true }, { balances: ["5000"] }],
    ] as const) {
      const { deps, calls } = setup(overrides, opts);
      await expect(runE2e(deps)).rejects.toThrow(LabRefusal);
      expect(calls.api).toEqual([]);
    }
  });

  test("a source with another signer on the ledger, before calling the API", async () => {
    const { deps, calls } = setup(
      { submit: true },
      {
        ledgerSigners: [
          { key: source, type: "ed25519_public_key", weight: 1 },
          { key: destination, type: "ed25519_public_key", weight: 1 },
        ],
      }
    );
    await expect(runE2e(deps)).rejects.toThrow(/only signer/);
    expect(calls.api).toEqual([]);
    expect(calls.signed).toBe(0);
  });

  test("an API read of the source that disagrees with Horizon", async () => {
    const changes: Partial<AccountState>[] = [
      { nativeBalanceLumens: "4.9999999" },
      { thresholds: { low: 0, med: 0, high: 1 } },
      {
        signers: [
          { key: source, type: "ed25519_public_key", weight: 1 },
          { key: destination, type: "ed25519_public_key", weight: 1 },
        ],
      },
    ];
    for (const change of changes) {
      const { deps, calls } = setup({ submit: true });
      const getAccount = deps.api.getAccount;
      deps.api.getAccount = async (...args) => ({ ...(await getAccount(...args)), ...change });
      await expect(runE2e(deps)).rejects.toThrow(/disagrees with Horizon/);
      expect(calls.api).toEqual(["account"]);
      expect(calls.signed).toBe(0);
    }
  });

  test("a plan that needs a decision about the account's assets", async () => {
    const { deps, calls } = setup({ submit: true });
    deps.api.closePlan = (async () => ({
      planHash: "p",
      blockers: [],
      decisionPoints: [{ id: "asset:USDC-GISSUER", required: true }],
    })) as unknown as CloseApi["closePlan"];
    await expect(runE2e(deps)).rejects.toThrow(/decisions the lab does not make/);
    expect(calls.signed).toBe(0);
  });

  test("a blocked plan", async () => {
    const { deps } = setup({ submit: true });
    deps.api.closePlan = (async () => ({
      planHash: "p",
      blockers: [{ code: "issuer_with_supply", message: "x" }],
      decisionPoints: [],
    })) as unknown as CloseApi["closePlan"];
    await expect(runE2e(deps)).rejects.toThrow(/blocked/);
  });
});

describe("e2e submit", () => {
  test("signs only after the typed confirmation and checks the source is gone on Horizon", async () => {
    const { deps, calls, captured } = setup({ submit: true });
    const report = await runE2e(deps);
    expect(calls.prompt).toBe(1);
    expect(calls.signed).toBe(1);
    expect(calls.verified).toEqual(["close-1"]);
    expect(calls.horizon).toBe(2);
    expect(captured()?.planHash).toBe("plan-hash");
    expect(captured()?.transactionHash?.("x")).toBe("hash");
    expect(report.submitted).toBe(true);
    expect(report.steps.map((s) => s.step)).toEqual([
      "analyze",
      "plan",
      "build round 1",
      "confirm close-1",
    ]);
  });

  test("fails when the source still exists after the close", async () => {
    const { deps } = setup({ submit: true }, { balances: ["5", "5"] });
    await expect(runE2e(deps)).rejects.toThrow(/still exists/);
  });
});
