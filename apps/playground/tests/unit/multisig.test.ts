import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest, type NextResponse } from "next/server";
import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  hash,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";
import { LumenWipeApiError } from "@lumenwipe/sdk";
import { runCloseRound } from "@/lib/demolish";
import {
  dormantPreAuthKey,
  executeMessStep,
  multisigSigners,
  type MessContext,
} from "@/lib/mess-builders";
import {
  handleCredentials,
  handleDemolishRound,
  handleMess,
  handleState,
} from "@/lib/route-handlers";
import {
  BASE_RESERVE_XLM,
  resolvePlan,
  type MultisigVariant,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { multisigFeesXlm } from "@/lib/scenarios/definitions";
import type { SessionStore } from "@/lib/session-store";
import { FakeMultisigLedger } from "./multisig-fixtures";
import { memoryStore, newSessionData } from "./session-fixtures";

// The multi-signature scenario from the mess step to the merge: the executor records every signer
// (its secret encrypted) before it adds them, and the close removes them in a round of its own,
// signed with the demo key and the recorded keys or preimage only, then merges. The network and
// the API are the fake ledger in ./multisig-fixtures, which judges signatures as stellar-core
// does. Keys and preimages are generated per run; the "encryption" is a reversible stand-in so
// the tests can look for every plaintext in what the routes return and log.

const ORIGIN = "http://localhost:3002";
const ENC = "enc:";
const encrypt = (plaintext: string): string => ENC + Buffer.from(plaintext).toString("base64");
const decrypt = (payload: string): string => {
  if (!payload.startsWith(ENC)) throw new Error("not a test payload");
  return Buffer.from(payload.slice(ENC.length), "base64").toString("utf8");
};
const noSleep = async (): Promise<void> => {};

const mm = Keypair.random();
const issuer = Keypair.random();
const VARIANTS: readonly MultisigVariant[] = ["two_of_three", "hash_x", "pre_auth"];
const selectionOf = (variant: number): ScenarioSelection => ({
  scenarios: [{ id: "multisig", params: { variant } }],
});

interface Posted {
  tx: Transaction;
  events: string[];
}

/** Runs the MULTISIG step through the mess route with the real executor, capturing its envelope. */
async function messStep(
  store: SessionStore,
  variant: number,
  submit: (tx: Transaction) => Promise<string> = async () => "a".repeat(64)
): Promise<{ id: string; demo: Keypair; res: NextResponse; posted: Posted[]; secrets: string[] }> {
  const demo = Keypair.random();
  const session = await store.createSession({
    ...newSessionData(),
    demoPublic: demo.publicKey(),
    encDemoSecret: encrypt(demo.secret()),
    selection: selectionOf(variant),
    completedMessSteps: ["SETUP"],
  });
  const posted: Posted[] = [];
  const events: string[] = [];
  const secrets: string[] = [];
  const res = await handleMess(
    new NextRequest(new URL(`/api/session/${session.id}/mess`, ORIGIN), {
      method: "POST",
      body: JSON.stringify({ stepId: "MULTISIG" }),
    }),
    session.id,
    {
      store,
      issuer: () => issuer,
      mm: () => mm,
      encrypt,
      decrypt,
      executeMessStep: (planned, ctx: MessContext) =>
        executeMessStep(
          planned,
          {
            ...ctx,
            recordSigner: async (signer) => {
              if (signer.secret !== null) secrets.push(signer.secret);
              events.push(`record:${signer.type}`);
              await ctx.recordSigner(signer);
            },
          },
          {
            loadAccount: async () => ({ sequenceNumber: () => "100" }),
            submit: async (signedXdr) => {
              const tx = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET) as Transaction;
              events.push("submit");
              posted.push({ tx, events: [...events] });
              return { txHash: await submit(tx) };
            },
          }
        ),
    }
  );
  return { id: session.id, demo, res, posted, secrets };
}

/** Runs close rounds through the demolish route until the merge, as the page's loop does. */
async function closeAll(store: SessionStore, id: string, ledger: FakeMultisigLedger) {
  const bodies: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await handleDemolishRound(id, {
      store,
      issuer: () => issuer,
      mm: () => mm,
      api: () => ({ apiUrl: "http://localhost:3001", apiKey: "unused" }),
      feeAccount: () => null,
      decrypt,
      runDemolish: (opts) => runCloseRound(ledger, ledger, opts, noSleep),
    });
    const body = (await res.json()) as Record<string, unknown>;
    bodies.push({ status: res.status, ...body });
    if (res.status !== 200 || body.done === true) break;
  }
  return bodies;
}

async function ledgerFor(store: SessionStore, id: string, demo: Keypair) {
  const session = await store.loadSession(id);
  return new FakeMultisigLedger(demo.publicKey(), mm.publicKey(), session!.recordedSigners);
}

describe("the multi-signature mess step", () => {
  test.each(VARIANTS.map((v, i) => [v, i] as const))(
    "%s: records every signer before one transaction adds them and raises the thresholds",
    async (variant, index) => {
      const store = memoryStore();
      const { id, demo, res, posted } = await messStep(store, index);
      expect(res.status).toBe(200);
      expect(posted).toHaveLength(1);
      const { tx, events } = posted[0]!;
      const recorded = (await store.loadSession(id))!.recordedSigners;
      expect(events[events.length - 1]).toBe("submit");
      expect(events.filter((e) => e.startsWith("record:"))).toHaveLength(recorded.length);

      // Signed by the demo key alone: the thresholds it raises apply only after it.
      expect(tx.signatures).toHaveLength(1);
      expect(Buffer.from(tx.signatures[0]!.hint.toBytes())).toEqual(
        Buffer.from(demo.signatureHint())
      );
      const ops = tx.operations as Operation.SetOptions[];
      expect(ops).toHaveLength(recorded.length + 1);
      expect(ops[ops.length - 1]).toMatchObject({
        lowThreshold: 2,
        medThreshold: 2,
        highThreshold: 2,
      });
      const added = ops.slice(0, -1).map((op) => op.signer);
      expect(added.every((s) => s?.weight === 1)).toBe(true);
      expect(recorded.map((s): string => s.type)).toEqual(
        {
          two_of_three: ["ed25519_public_key", "ed25519_public_key"],
          hash_x: ["hash_x"],
          pre_auth: ["ed25519_public_key", "ed25519_public_key", "preauth_tx"],
        }[variant]
      );
      expect(recorded.every((s) => s.weight === 1)).toBe(true);
    }
  );

  test("a hash(x) signer's key is the hash of the preimage the session stores encrypted", async () => {
    const store = memoryStore();
    const { id } = await messStep(store, 1);
    const [signer] = (await store.loadSession(id))!.recordedSigners;
    const preimage = Buffer.from(decrypt(signer!.encSecret!), "hex");
    expect(preimage).toHaveLength(32);
    expect(StrKey.encodeSha256Hash(hash(preimage))).toBe(signer!.key);
  });

  test("a pre-authorized transaction signer is dormant and keeps nothing to sign with", async () => {
    const store = memoryStore();
    const { id, demo } = await messStep(store, 2);
    const preauth = (await store.loadSession(id))!.recordedSigners.find(
      (s) => s.type === "preauth_tx"
    );
    expect(preauth).toMatchObject({ key: dormantPreAuthKey(demo.publicKey()), encSecret: null });
    // Not the hash of anything the demo could still send: the same key for every run.
    expect(dormantPreAuthKey(demo.publicKey())).toBe(dormantPreAuthKey(demo.publicKey()));
  });

  test("each run of the step makes new keys and a new preimage", () => {
    const demo = Keypair.random().publicKey();
    const keys = (v: MultisigVariant) => multisigSigners(v, demo).map((s) => s.key);
    expect(keys("two_of_three")).not.toEqual(keys("two_of_three"));
    expect(keys("hash_x")).not.toEqual(keys("hash_x"));
  });
});

describe("closing a multi-signature demo", () => {
  test.each(VARIANTS.map((v, i) => [v, i] as const))(
    "%s: the signers go in a round of their own, then the merge, each signed just enough",
    async (variant, index) => {
      const store = memoryStore();
      const { id, demo } = await messStep(store, index);
      const ledger = await ledgerFor(store, id, demo);
      const bodies = await closeAll(store, id, ledger);

      expect(bodies[bodies.length - 1]).toMatchObject({ status: 200, done: true });
      expect(ledger.submitted.map((s) => s.refused)).toEqual([null, null]);
      expect(ledger.submitted[0]!.ops.every((op) => op === "setOptions")).toBe(true);
      expect(ledger.submitted[1]!.ops).toEqual(["accountMerge"]);
      expect(ledger.open).toBe(false);
      const removed = variant === "hash_x" ? 1 : variant === "two_of_three" ? 2 : 3;
      expect(ledger.submitted[0]!.ops).toHaveLength(removed + 1);
      const log = (await store.loadSession(id))!.demolishLog.map((e) => e.txId);
      expect(log).toEqual(["normalize", "merge"]);
    }
  );

  test("a transaction the recorded keys cannot fully sign is refused before it is sent", async () => {
    const store = memoryStore();
    const { id, demo } = await messStep(store, 0);
    const ledger = await ledgerFor(store, id, demo);
    ledger.thresholds = { low: 3, med: 3, high: 4 };
    const bodies = await closeAll(store, id, ledger);

    expect(bodies[0]!.status).not.toBe(200);
    expect(ledger.submitted).toEqual([]);
    expect(ledger.open).toBe(true);
    expect((await store.loadSession(id))!.demolishPending).toBeNull();
  });

  test("a signer added outside the session stops the close before anything is signed", async () => {
    const store = memoryStore();
    const { id, demo } = await messStep(store, 0);
    const ledger = await ledgerFor(store, id, demo);
    const stranger = Keypair.random();
    ledger.signers.push({ key: stranger.publicKey(), type: "ed25519_public_key", weight: 1 });
    const bodies = await closeAll(store, id, ledger);

    // The verifier refuses removing a signer the session never recorded (tests/unit/verify.test.ts).
    expect(bodies).toEqual([{ status: 502, error: "demolish_failed" }]);
    expect(ledger.submitted).toEqual([]);
  });
});

describe("the cost of a multi-signature demo", () => {
  test("covers each signer's reserve and the fees of adding and removing them", () => {
    // Two co-signers: a three-operation mess step bidding 600 stroops per operation (1,800), then
    // a three-operation removal at 100 each (300).
    expect(multisigFeesXlm(2)).toBeCloseTo(0.00021, 10);
    expect(multisigFeesXlm(1)).toBeCloseTo(0.0001, 10);
    expect(multisigFeesXlm(3)).toBeCloseTo(0.00036, 10);
    for (const [index, signers] of [
      [0, 2],
      [1, 1],
      [2, 3],
    ] as const) {
      const { cost } = resolvePlan(selectionOf(index));
      // The demo's own two base reserves and its setup transaction come first.
      const expected = 2 * BASE_RESERVE_XLM + signers * BASE_RESERVE_XLM + multisigFeesXlm(signers);
      expect(cost.xlm).toBeCloseTo(expected, 10);
      expect(cost.subEntries).toBe(signers);
      expect(cost.classicTransactions).toBe(2);
    }
  });
});

describe("no co-signer secret or preimage leaves the server", () => {
  let logged: string[] = [];
  const spies: { mockRestore: () => void }[] = [];
  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error", "info", "debug"] as const) {
      spies.push(
        spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(
            args
              .map((a) => (a instanceof Error ? `${a.name} ${a.message}` : JSON.stringify(a)))
              .join(" ")
          );
        })
      );
    }
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const leaks = (text: string, secrets: string[]): string[] =>
    secrets.filter((s) => text.includes(s) || text.includes(encrypt(s)));

  test.each([
    [0, "co-signer keys"],
    [1, "a preimage"],
  ] as const)("variant %d, %s: in the store, the responses and the logs", async (index) => {
    const store = memoryStore();
    const { id, demo, res, secrets } = await messStep(store, index);
    expect(secrets.length).toBeGreaterThan(0);
    expect(leaks(JSON.stringify(await res.json()), secrets)).toEqual([]);

    const stored = (await store.loadSession(id))!;
    expect(JSON.stringify(stored).includes(secrets[0]!)).toBe(false);

    const state = await handleState(id, {
      store,
      api: () => ({ apiUrl: "http://localhost:3001", apiKey: "unused" }),
      accountReader: () => async () => {
        throw new LumenWipeApiError(404, { error: { code: "account_not_found", message: "x" } });
      },
    });
    expect(leaks(JSON.stringify(await state.json()), secrets)).toEqual([]);
    const credentials = await handleCredentials(
      new NextRequest(new URL(`/api/session/${id}/credentials`, ORIGIN), { method: "POST" }),
      id,
      { store, rateLimit: async () => null, decrypt }
    );
    expect(leaks(JSON.stringify(await credentials.json()), secrets)).toEqual([]);

    // A round that fails after signing, and a mess step that fails after recording.
    const ledger = await ledgerFor(store, id, demo);
    ledger.thresholds = { low: 4, med: 4, high: 4 };
    expect((await closeAll(store, id, ledger))[0]!.status).not.toBe(200);
    const failed = await messStep(memoryStore(), index, async () => {
      throw new Error("tx_bad_seq");
    });
    expect(failed.res.status).toBe(502);
    expect(leaks(JSON.stringify(await failed.res.json()), failed.secrets)).toEqual([]);
    expect(leaks(logged.join("\n"), [...secrets, ...failed.secrets])).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
  });
});
