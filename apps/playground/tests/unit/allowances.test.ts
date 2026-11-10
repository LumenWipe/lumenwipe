import { describe, expect, test } from "bun:test";
import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Allowance } from "@lumenwipe/sdk";
import { RevokeAllowanceVerificationError } from "@lumenwipe/verify";
import {
  recordedListed,
  revokeRecordedAllowance,
  type AllowanceApi,
  type RevokeOptions,
} from "@/lib/allowances";
import { executeMessStep, type BuildSignSubmitDeps, type MessContext } from "@/lib/mess-builders";
import { runMessStep, runRevokeAllowance } from "@/lib/session-actions";
import type { ContractCall } from "@/lib/soroban-seed";
import type { RecordedAllowance } from "@/lib/session-store";
import { ALLOWANCE_SEED, resolvePlan, XLM_SAC } from "@/lib/scenarios";
import { RevokeVerificationError } from "@/lib/verify-revoke";
import { gate, memoryStore, newSessionData, tick } from "./session-fixtures";
import { revokeTx, withMemo } from "./revoke-fixtures";

// The allowances scenario with the network replaced: the exact approve each step sends and the
// record written before it, the revoke's two checks in front of the demo key, and the locked action
// that runs it.

const demo = Keypair.random();
const TTL = { latestLedger: 5_000_000, maxEntryTtl: 3_110_400 };
const FAR = TTL.latestLedger + TTL.maxEntryTtl - 1;
const NEAR = TTL.latestLedger + ALLOWANCE_SEED.liveLedgers;

const selection = (spenders: number) => ({
  scenarios: [{ id: "allowances" as const, params: { spenders } }],
});
const stepsOf = (spenders: number) =>
  resolvePlan(selection(spenders)).steps.filter((s) => s.action.kind === "approve_allowance");

interface Run {
  events: string[];
  calls: ContractCall[];
  recorded: RecordedAllowance[];
}

function harness(existing: RecordedAllowance[] = []): {
  run: Run;
  ctx: MessContext;
  deps: BuildSignSubmitDeps;
} {
  const run: Run = { events: [], calls: [], recorded: [...existing] };
  const ctx: MessContext = {
    demo,
    ephemeralIssuers: new Map(),
    persistentIssuer: Keypair.random(),
    mmPublic: Keypair.random().publicKey(),
    transferRecipient: null,
    helpers: new Map(),
    recordSigner: async () => {},
    recordClaimableBalances: async () => {},
    allowances: existing,
    recordAllowance: async (index, allowance) => {
      run.events.push(`record ${index}`);
      run.recorded[index - 1] = allowance;
    },
  };
  const deps: BuildSignSubmitDeps = {
    ledgerTtl: async () => TTL,
    contractCall: async (_source, call) => {
      run.events.push("call");
      run.calls.push(call);
      return { txHash: `hash-${run.calls.length}` };
    },
  };
  return { run, ctx, deps };
}

const native = (call: ContractCall): unknown[] => call.args.map((a) => scValToNative(a) as unknown);

describe("the approve step", () => {
  test("each spender gets exactly one approve on XLM's asset contract, recorded before it is sent", async () => {
    const { run, ctx, deps } = harness();
    for (const step of stepsOf(3)) {
      ctx.allowances = [...run.recorded];
      await executeMessStep(step, ctx, deps);
    }
    expect(run.events).toEqual(["record 1", "call", "record 2", "call", "record 3", "call"]);
    const spenders = run.recorded.map((r) => r.spender);
    expect(new Set(spenders).size).toBe(3);
    for (const s of spenders) expect(s).toMatch(/^G[A-Z2-7]{55}$/);
    expect(run.recorded.map((r) => [r.token, r.liveUntilLedger])).toEqual([
      [XLM_SAC, FAR],
      [XLM_SAC, NEAR],
      [XLM_SAC, NEAR],
    ]);
    run.calls.forEach((call, i) => {
      expect(call.contract).toBe(XLM_SAC);
      expect(call.function).toBe("approve");
      expect(call.args.map((a) => a.type)).toEqual([
        "scvAddress",
        "scvAddress",
        "scvI128",
        "scvU32",
      ]);
      const xlm = BigInt(Number(ALLOWANCE_SEED.amountsXlm[i]) * 10_000_000);
      expect(native(call)).toEqual([demo.publicKey(), spenders[i], xlm, i === 0 ? FAR : NEAR]);
    });
  });

  test("a retried step approves the spender its earlier attempt recorded again", async () => {
    const earlier: RecordedAllowance = {
      token: XLM_SAC,
      spender: Keypair.random().publicKey(),
      liveUntilLedger: 7,
    };
    const { run, ctx, deps } = harness([earlier]);
    await executeMessStep(stepsOf(1)[0]!, ctx, deps);
    expect(run.recorded).toEqual([
      { token: XLM_SAC, spender: earlier.spender, liveUntilLedger: FAR },
    ]);
    expect(native(run.calls[0]!)[1]).toBe(earlier.spender);
  });

  test("nothing is sent when the allowance cannot be recorded", async () => {
    const { run, ctx, deps } = harness();
    ctx.recordAllowance = async () => Promise.reject(new Error("store down"));
    await expect(executeMessStep(stepsOf(1)[0]!, ctx, deps)).rejects.toThrow("store down");
    expect(run.calls).toHaveLength(0);
  });

  test("the session holds each spender before its approve leaves, and keeps one per spender", async () => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      selection: selection(2),
      completedMessSteps: ["SETUP"],
    });
    const seen: RecordedAllowance[][] = [];
    for (const [i, step] of stepsOf(2).entries()) {
      const attempts = i === 0 ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = await runMessStep(store, session.id, step.id, {
          executeStep: (planned, current, _s, _c, recordAllowance) => {
            const { ctx, deps } = harness(current.allowances);
            ctx.recordAllowance = recordAllowance;
            deps.contractCall = async () => {
              seen.push((await store.loadSession(session.id))!.allowances);
              if (attempt < attempts) throw new Error("send failed");
              return { txHash: "hash" };
            };
            return executeMessStep(planned, ctx, deps);
          },
        });
        expect(result.status).toBe(attempt < attempts ? 502 : 200);
      }
    }
    // Each call saw its spender in the record already, and the retry kept the same one.
    expect(seen.map((s) => s.length)).toEqual([1, 1, 2]);
    expect(seen[1]![0]!.spender).toBe(seen[0]![0]!.spender);
    const stored = (await store.loadSession(session.id))!.allowances;
    expect(stored).toHaveLength(2);
    expect(stored[0]!.spender).toBe(seen[0]![0]!.spender);
  });
});

const spender = Keypair.random().publicKey();
const otherSpender = Keypair.random().publicKey();
const RECORDED: RecordedAllowance[] = [
  { token: XLM_SAC, spender, liveUntilLedger: FAR },
  { token: XLM_SAC, spender: otherSpender, liveUntilLedger: NEAR },
];

const listed = (s: string, token = XLM_SAC): Allowance =>
  ({ token, spender: s, amount: "100000000" }) as Allowance;

describe("recordedListed", () => {
  test("is the record, numbered by it, each marked with whether the API lists it", () => {
    const stranger = Keypair.random().publicKey();
    // The API missed the first (its list is best effort) and lists one never recorded, which is
    // left out: the record, not the list, decides what is revoked.
    expect(
      recordedListed([listed(stranger), listed(otherSpender), listed(spender, "CTOKEN")], RECORDED)
    ).toEqual([
      { index: 1, token: XLM_SAC, spender, listed: false, amount: null },
      { index: 2, token: XLM_SAC, spender: otherSpender, listed: true, amount: "100000000" },
    ]);
  });
});

interface ApiLog {
  asked: unknown[];
  submitted: string[];
}

function revokeOpts(transaction: (s: string) => string, overrides: Partial<RevokeOptions> = {}) {
  const log: ApiLog = { asked: [], submitted: [] };
  const api: AllowanceApi = {
    getAllowances: async () => ({ allowances: [] }),
    revokeAllowance: async (params) => {
      log.asked.push(params);
      return { transaction: transaction(params.spender) };
    },
    submit: async (signedXdr) => {
      log.submitted.push(signedXdr);
      return { hash: "the-api-says-this" };
    },
  };
  const opts: RevokeOptions = {
    demo,
    signingKeys: [],
    recorded: RECORDED,
    allowance: RECORDED[0]!,
    api,
    signerState: async () => ({
      signers: [{ key: demo.publicKey(), type: "ed25519_public_key", weight: 1 }],
      thresholds: { low: 0, med: 0, high: 0 },
    }),
    ...overrides,
  };
  return { log, opts };
}

const envelope = (tx: Transaction): string => tx.toEnvelope().toXDR("base64");

describe("revokeRecordedAllowance", () => {
  test("asks for the recorded allowance, signs what both checks accept and returns its own hash", async () => {
    const tx = revokeTx({ owner: demo.publicKey(), spender });
    const { log, opts } = revokeOpts(() => envelope(tx));
    const hash = await revokeRecordedAllowance(opts);
    expect(log.asked).toEqual([{ owner: demo.publicKey(), token: XLM_SAC, spender }]);
    expect(log.submitted).toHaveLength(1);
    const signed = TransactionBuilder.fromXDR(log.submitted[0]!, Networks.TESTNET) as Transaction;
    expect(signed.signatures).toHaveLength(1);
    expect(hash).toBe(Buffer.from(tx.hash()).toString("hex"));
  });

  test("a revoke the playground's check refuses is never signed or sent", async () => {
    const { log, opts } = revokeOpts(() =>
      envelope(revokeTx({ owner: demo.publicKey(), spender: Keypair.random().publicKey() }))
    );
    const err = await revokeRecordedAllowance(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevokeVerificationError);
    expect((err as RevokeVerificationError).code).toBe("revoke_spender_not_recorded");
    expect(log.submitted).toHaveLength(0);
  });

  test("the shared anchor refuses what gets past the playground's check, with its own code", async () => {
    // The other recorded spender passes the playground's membership check; the anchor holds the
    // transaction to the allowance asked for. A memo is nothing the playground's check reads.
    for (const [tx, code] of [
      [
        revokeTx({ owner: demo.publicKey(), spender: otherSpender }),
        "revoke_approve_args_mismatch",
      ],
      [withMemo(revokeTx({ owner: demo.publicKey(), spender }), "x"), "revoke_memo_present"],
    ] as const) {
      const { log, opts } = revokeOpts(() => envelope(tx));
      const err = await revokeRecordedAllowance(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RevokeAllowanceVerificationError);
      expect((err as RevokeAllowanceVerificationError).code).toBe(code);
      expect(log.submitted).toHaveLength(0);
    }
  });

  test("an allowance the session did not record is not even asked for", async () => {
    const stranger: RecordedAllowance = {
      token: XLM_SAC,
      spender: Keypair.random().publicKey(),
      liveUntilLedger: 1,
    };
    const { log, opts } = revokeOpts(() => "", { allowance: stranger });
    await expect(revokeRecordedAllowance(opts)).rejects.toThrow("recorded");
    expect(log.asked).toHaveLength(0);
  });

  test("a demo whose thresholds its keys cannot reach signs nothing it sends", async () => {
    const { log, opts } = revokeOpts(
      () => envelope(revokeTx({ owner: demo.publicKey(), spender })),
      {
        signerState: async () => ({
          signers: [{ key: demo.publicKey(), type: "ed25519_public_key", weight: 1 }],
          thresholds: { low: 2, med: 2, high: 2 },
        }),
      }
    );
    await expect(revokeRecordedAllowance(opts)).rejects.toThrow("weight");
    expect(log.submitted).toHaveLength(0);
  });
});

describe("runRevokeAllowance", () => {
  const recordedSession = async (patch: Partial<ReturnType<typeof newSessionData>> = {}) => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      selection: selection(2),
      allowances: RECORDED,
      ...patch,
    });
    return { store, session };
  };

  test("revokes a recorded spender with the record's allowance, holding the session lock", async () => {
    const { store, session } = await recordedSession();
    const held = gate();
    const revoked: RecordedAllowance[] = [];
    const first = runRevokeAllowance(store, session.id, otherSpender, {
      revoke: async (_s, allowance) => {
        revoked.push(allowance);
        await held.wait;
        return "hash";
      },
    });
    await tick();
    // While the revoke holds the lock, a step, another revoke or a close round is turned away.
    const second = await runRevokeAllowance(store, session.id, spender, {
      revoke: async () => "never",
    });
    expect(second).toEqual({ status: 409, body: { error: "step_in_progress" } });
    held.open();
    expect(await first).toEqual({ status: 200, body: { spender: otherSpender, txHash: "hash" } });
    expect(revoked).toEqual([RECORDED[1]!]);
  });

  test("a spender the session did not record is refused before anything is built", async () => {
    const { store, session } = await recordedSession();
    let called = false;
    const result = await runRevokeAllowance(store, session.id, Keypair.random().publicKey(), {
      revoke: async () => {
        called = true;
        return "hash";
      },
    });
    expect(result).toEqual({ status: 400, body: { error: "allowance_not_recorded" } });
    expect(called).toBe(false);
  });

  test("refused once the close merged the demo or has a transaction in flight", async () => {
    for (const patch of [
      { demolishDone: true },
      {
        demolishPending: {
          txId: "t",
          hash: "h",
          summary: "s",
          operations: [],
          validUntil: null,
          closesAccount: false,
        },
      },
    ]) {
      const { store, session } = await recordedSession(patch);
      const result = await runRevokeAllowance(store, session.id, spender, {
        revoke: async () => "hash",
      });
      expect(result).toEqual({ status: 409, body: { error: "demolish_in_progress" } });
    }
  });

  test("a check's refusal is reported as refused, anything else as failed", async () => {
    const { store, session } = await recordedSession();
    const refused = await runRevokeAllowance(store, session.id, spender, {
      revoke: async () => {
        throw new RevokeVerificationError("revoke_amount_not_zero");
      },
    });
    expect(refused).toEqual({ status: 422, body: { error: "revoke_refused" } });
    const failed = await runRevokeAllowance(store, session.id, spender, {
      revoke: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(failed).toEqual({ status: 502, body: { error: "revoke_failed" } });
  });
});
