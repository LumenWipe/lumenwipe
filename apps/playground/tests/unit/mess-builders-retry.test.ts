import { describe, test, expect } from "bun:test";
import {
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  addForgottenSigner,
  loadAccountWithRetry,
  buildSignSubmit,
  EmptyTransactionError,
  executeMessStep,
  TxSubmitError,
  type ClaimableBalanceRecord,
  type MessContext,
} from "@/lib/mess-builders";
import { resolvePlan, type MessStepDef, type ScenarioSelection } from "@/lib/scenarios";

const ADDR = "GBOYVOCQNI34T7IO6RPNE6RZCVD7WNTFJZJUEX64RSQF6IJT5NFDRGMN";
const notFound = (addr: string) => new Error(`Account not found: ${addr}`);

test("loadAccountWithRetry retries while the account is not yet visible, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await loadAccountWithRetry(
    async (addr) => {
      calls++;
      if (calls < 3) throw notFound(addr);
      return { id: addr };
    },
    ADDR,
    { attempts: 6, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) }
  );
  expect(calls).toBe(3);
  expect(sleeps.length).toBe(2);
  expect(result.id).toBe(ADDR);
});

test("loadAccountWithRetry gives up after the attempt budget", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async (addr) => {
        calls++;
        throw notFound(addr);
      },
      ADDR,
      { attempts: 4, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/account not found/i);
  expect(calls).toBe(4);
});

test("loadAccountWithRetry does not retry unrelated errors", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async () => {
        calls++;
        throw new Error("network unreachable");
      },
      ADDR,
      { attempts: 5, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/network unreachable/);
  expect(calls).toBe(1);
});

function manageDataOp() {
  return Operation.manageData({ name: "k", value: "v" });
}

test("buildSignSubmit retries on tx_bad_seq, re-reading the account each attempt", async () => {
  const kp = Keypair.random();
  const seqs = ["100", "100", "101"];
  let reads = 0;
  let submits = 0;
  const sleeps: number[] = [];

  const txHash = await buildSignSubmit(kp, [manageDataOp()], [], {
    loadAccount: async () => ({ sequenceNumber: () => seqs[reads++] ?? "101" }),
    submit: async () => {
      submits++;
      if (submits < 3) throw new TxSubmitError("rejected", "tx_bad_seq");
      return { txHash: "deadbeef" };
    },
    sleep: async (ms) => void sleeps.push(ms),
  });

  expect(txHash).toBe("deadbeef");
  expect(submits).toBe(3);
  expect(reads).toBe(3);
  expect(sleeps.length).toBe(2);
});

test("buildSignSubmit retries on tx_no_account, then succeeds", async () => {
  const kp = Keypair.random();
  let submits = 0;

  const txHash = await buildSignSubmit(kp, [manageDataOp()], [], {
    loadAccount: async () => ({ sequenceNumber: () => "100" }),
    submit: async () => {
      submits++;
      if (submits < 2) throw new TxSubmitError("source missing", "tx_no_account");
      return { txHash: "cafe" };
    },
    sleep: async () => {},
  });

  expect(txHash).toBe("cafe");
  expect(submits).toBe(2);
});

test("buildSignSubmit does not retry non-transient submission errors", async () => {
  const kp = Keypair.random();
  let submits = 0;

  await expect(
    buildSignSubmit(kp, [manageDataOp()], [], {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      submit: async () => {
        submits++;
        throw new TxSubmitError("underfunded", "tx_insufficient_balance");
      },
      sleep: async () => {},
    })
  ).rejects.toThrow(/underfunded/);
  expect(submits).toBe(1);
});

test("buildSignSubmit gives up after the retry budget and rethrows", async () => {
  const kp = Keypair.random();
  let submits = 0;

  await expect(
    buildSignSubmit(kp, [manageDataOp()], [], {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      submit: async () => {
        submits++;
        throw new TxSubmitError("rejected", "tx_bad_seq");
      },
      sleep: async () => {},
    })
  ).rejects.toBeInstanceOf(TxSubmitError);
  expect(submits).toBe(5);
});

test("buildSignSubmit refuses a transaction with no operations before reading or signing anything", async () => {
  const kp = Keypair.random();
  let reads = 0;
  let submits = 0;
  const signed: Transaction[] = [];

  const attempt = buildSignSubmit(
    kp,
    [],
    [],
    {
      loadAccount: async () => {
        reads++;
        return { sequenceNumber: () => "100" };
      },
      submit: async () => {
        submits++;
        return { txHash: "never" };
      },
      sleep: async () => {},
    },
    async (tx) => void signed.push(tx)
  );
  await expect(attempt).rejects.toBeInstanceOf(EmptyTransactionError);
  await expect(attempt).rejects.toThrow(
    `Refusing to submit a transaction with no operations from ${kp.publicKey()}`
  );
  expect([reads, submits, signed.length]).toEqual([0, 0, 0]);
});

describe("the setup step sends only what it has to do", () => {
  const demo = Keypair.random();
  const mm = Keypair.random().publicKey();
  const usdc = Keypair.random();
  const setupOf = (selection: ScenarioSelection): MessStepDef => {
    const step = resolvePlan(selection).steps[0];
    if (step?.action.kind !== "setup") throw new Error("a plan that does not start with setup");
    return step;
  };
  const fundingOf = (step: MessStepDef): string =>
    step.action.kind === "setup" ? step.action.fundingXlm : "";
  const ctx: MessContext = {
    demo,
    ephemeralIssuers: new Map([["USDC", usdc]]),
    persistentIssuer: Keypair.random(),
    mmPublic: mm,
    transferRecipient: null,
    helpers: new Map(),
    recordSigner: async () => {},
    recordClaimableBalances: async () => {},
    allowances: [],
    recordAllowance: async () => {},
  };
  /** Runs the step against a demo holding `balance`, capturing what it would send. */
  async function run(step: MessStepDef, balance: string) {
    const sent: Transaction[] = [];
    const outcome = await executeMessStep(step, ctx, {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      loadNativeBalance: async () => ({ balance, sellingLiabilities: "0" }),
      submit: async (signedXdr) => {
        const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
        if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
        sent.push(tx);
        return { txHash: "setup" };
      },
      sleep: async () => {},
    });
    return { outcome, sent };
  }
  const signerOnly: ScenarioSelection = { scenarios: [{ id: "forgotten-signer", params: {} }] };

  test("with no ephemeral issuers and exactly its funding, it sends no transaction", async () => {
    const step = setupOf(signerOnly);
    expect(step.action).toMatchObject({ kind: "setup", ephemeralAssets: [] });
    const { outcome, sent } = await run(step, fundingOf(step));
    expect(sent).toEqual([]);
    expect(outcome).toBeNull();
  });

  test("with no ephemeral issuers, it still returns XLM the demo holds over its funding", async () => {
    const step = setupOf(signerOnly);
    const over = (Number(fundingOf(step)) + 2.5).toFixed(7);
    const { outcome, sent } = await run(step, over);
    expect(outcome).toBe("setup");
    expect(sent.map((tx) => tx.operations)).toEqual([
      [expect.objectContaining({ type: "payment", destination: mm, amount: "2.5000000" })],
    ]);
  });

  test("with an ephemeral issuer and exactly its funding, it creates only the issuer", async () => {
    const step = setupOf({ scenarios: [{ id: "stablecoin-swaps", params: { tokens: 1 } }] });
    const { outcome, sent } = await run(step, fundingOf(step));
    expect(outcome).toBe("setup");
    expect(sent.map((tx) => tx.operations.map((op) => op.type))).toEqual([["createAccount"]]);
    expect(sent[0]!.operations[0]).toMatchObject({ destination: usdc.publicKey() });
  });
});

test("addForgottenSigner records the signer before sending the transaction that adds it", async () => {
  const demo = Keypair.random();
  const events: string[] = [];
  let recorded = "";
  const hash = await addForgottenSigner(
    {
      demo,
      recordSigner: async (signer) => {
        recorded = signer.key;
        events.push("record");
      },
    },
    {
      loadAccount: async () => ({ sequenceNumber: () => "1" }),
      submit: async (signedXdr) => {
        events.push("submit");
        const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
        const op = tx.operations[0] as Operation.SetOptions;
        expect(op.signer).toEqual({ ed25519PublicKey: recorded, weight: 1 });
        return { txHash: "added" };
      },
    }
  );
  expect(hash).toBe("added");
  expect(events).toEqual(["record", "submit"]);
  expect(recorded).toMatch(/^G[A-Z2-7]{55}$/);
});

test("addForgottenSigner sends nothing when the signer cannot be recorded", async () => {
  let submitted = false;
  await expect(
    addForgottenSigner(
      {
        demo: Keypair.random(),
        recordSigner: async () => {
          throw new Error("store down");
        },
      },
      {
        loadAccount: async () => ({ sequenceNumber: () => "1" }),
        submit: async () => {
          submitted = true;
          return { txHash: "added" };
        },
      }
    )
  ).rejects.toThrow("store down");
  expect(submitted).toBe(false);
});

describe("claimable balances are recorded before each attempt is sent", () => {
  const demo = Keypair.random();
  const bonus = Keypair.random();
  const claimant = Keypair.random();
  const step: MessStepDef = {
    id: "CLAIMABLE_BALANCES",
    label: "Leave balances",
    nodes: [],
    balances: [],
    action: {
      kind: "claimable_balances",
      claimantFundingXlm: "1.5",
      balances: [
        { asset: "BONUS", amount: "50", intent: "claim" },
        { asset: "native", amount: "1", intent: "demo_sponsored" },
      ],
    },
  };
  function ctx(recorded: ClaimableBalanceRecord[][], events: string[]): MessContext {
    return {
      demo,
      ephemeralIssuers: new Map([["BONUS", bonus]]),
      persistentIssuer: Keypair.random(),
      mmPublic: Keypair.random().publicKey(),
      transferRecipient: null,
      helpers: new Map([["claimant", claimant]]),
      recordSigner: async () => {},
      recordClaimableBalances: async (balances) => {
        events.push("record");
        recorded.push(balances);
      },
      allowances: [],
      recordAllowance: async () => {},
    };
  }

  test("each attempt's ids are the ones its signed transaction gives, recorded before it is sent", async () => {
    const recorded: ClaimableBalanceRecord[][] = [];
    const events: string[] = [];
    const sent: Transaction[] = [];
    let sequence = 1;
    await executeMessStep(step, ctx(recorded, events), {
      loadAccount: async () => ({ sequenceNumber: () => String(sequence++) }),
      submit: async (signedXdr) => {
        events.push("submit");
        const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
        if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
        sent.push(tx);
        if (sent.length === 1) throw new TxSubmitError("bad seq", "tx_bad_seq");
        return { txHash: "landed" };
      },
      sleep: async () => {},
    });
    expect(events).toEqual(["record", "submit", "record", "submit"]);
    // Attempts differ in sequence, so in ids: each record is its own attempt's.
    expect(recorded).toEqual(
      sent.map((tx) => [
        { id: tx.getClaimableBalanceId(1), asset: `BONUS:${bonus.publicKey()}`, intent: "claim" },
        { id: tx.getClaimableBalanceId(2), asset: "native", intent: "demo_sponsored" },
      ])
    );
    expect(recorded[0]![0]!.id).not.toBe(recorded[1]![0]!.id);
    const [create, bonusBalance, sponsored] = sent[1]!.operations;
    expect([create?.type, bonusBalance?.source, sponsored?.source]).toEqual([
      "createAccount",
      bonus.publicKey(),
      undefined,
    ]);
  });

  test("nothing is sent when the balances cannot be recorded", async () => {
    let submitted = false;
    const failing = {
      ...ctx([], []),
      recordClaimableBalances: async () => Promise.reject(new Error("store down")),
    };
    await expect(
      executeMessStep(step, failing, {
        loadAccount: async () => ({ sequenceNumber: () => "1" }),
        submit: async () => {
          submitted = true;
          return { txHash: "x" };
        },
      })
    ).rejects.toThrow("store down");
    expect(submitted).toBe(false);
  });
});
