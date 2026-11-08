import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  cosignRequirement,
  cosignStatement,
  type CosignInput,
  type CosignRequirement,
} from "@/lib/stellar/cosign-requirement";
import { CLAIM_PATTERNS } from "@/lib/journey/claims";
import { findBannedWords } from "@/lib/glossary";
import type { AccountSigner } from "@/types/account";
import type { ExecutionTxBreakdown } from "@/types/close-api";
import type { StepType } from "@/types/plan";

const MASTER = Keypair.random().publicKey();
const A = Keypair.random().publicKey();
const B = Keypair.random().publicKey();
const C = Keypair.random().publicKey();
const HASH_X = "hash-x-signer";
const PRE_AUTH = "pre-auth-signer";
const SIGNED_PAYLOAD = "signed-payload-signer";

function key(k: string, weight: number): AccountSigner {
  return { key: k, weight, type: "ed25519_public_key" };
}

function tx(order: number, ...covers: StepType[]): ExecutionTxBreakdown {
  return { order, covers };
}

const DIRECT_CLOSE = [tx(0, "NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES", "MERGE")];

function input(overrides: Partial<CosignInput>): CosignInput {
  return {
    account: MASTER,
    signers: [key(MASTER, 1), key(A, 1), key(B, 1)],
    thresholds: { low: 2, med: 2, high: 2 },
    transactions: DIRECT_CLOSE,
    viaRelay: false,
    ...overrides,
  };
}

function req(overrides: Partial<CosignInput>): CosignRequirement {
  const r = cosignRequirement(input(overrides));
  if (r === null) throw new Error("expected a cosign requirement");
  return r;
}

function statement(overrides: Partial<CosignInput>): string {
  return cosignStatement(req(overrides)).join(" ");
}

describe("cosignRequirement › N and M", () => {
  test("equal weights: the fewest keys that reach the high threshold", () => {
    expect(req({})).toMatchObject({ needed: 2, keys: 3 });
  });

  test("unequal weights are counted from the heaviest key down", () => {
    const signers = [key(MASTER, 1), key(A, 3), key(B, 1)];
    expect(cosignRequirement(input({ signers, thresholds: { low: 3, med: 3, high: 3 } }))).toBe(
      null
    );
    expect(req({ signers, thresholds: { low: 4, med: 4, high: 4 } })).toMatchObject({
      needed: 2,
      keys: 3,
    });
  });

  test("a key with weight 0 is not counted", () => {
    const signers = [key(MASTER, 1), key(A, 1), key(B, 0)];
    expect(req({ signers })).toMatchObject({ needed: 2, keys: 2 });
  });

  test("hash(x), pre-authorized and signed-payload signers are named, not counted as keys", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 5, type: "hash_x" },
      { key: PRE_AUTH, weight: 5, type: "preauth_tx" },
      { key: SIGNED_PAYLOAD, weight: 5, type: "ed25519_signed_payload" },
    ];
    expect(req({ signers })).toMatchObject({
      needed: 2,
      keys: 2,
      hashX: 1,
      preAuth: 1,
      signedPayload: 1,
    });
  });

  test("a non-key signer with weight 0 is not named", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 0, type: "hash_x" },
      { key: PRE_AUTH, weight: 0, type: "preauth_tx" },
      { key: SIGNED_PAYLOAD, weight: 0, type: "ed25519_signed_payload" },
    ];
    expect(req({ signers })).toMatchObject({ hashX: 0, preAuth: 0, signedPayload: 0 });
  });

  test("keys that cannot reach the threshold alone give no N", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 1, type: "hash_x" },
    ];
    expect(req({ signers, thresholds: { low: 3, med: 3, high: 3 } })).toMatchObject({
      needed: null,
      keys: 2,
      hashX: 1,
    });
  });

  test("a single-key account, or one key that reaches the threshold, needs no statement", () => {
    expect(
      cosignRequirement(
        input({ signers: [key(MASTER, 1)], thresholds: { low: 1, med: 1, high: 1 } })
      )
    ).toBe(null);
    expect(
      cosignRequirement(
        input({ signers: [key(MASTER, 2), key(A, 1)], transactions: null, viaRelay: true })
      )
    ).toBe(null);
  });

  test("a threshold nothing in this flow can reach says nothing", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      { key: SIGNED_PAYLOAD, weight: 5, type: "ed25519_signed_payload" },
    ];
    expect(cosignRequirement(input({ signers }))).toBe(null);
  });

  test("a high threshold of 0 still needs one signature, from one key", () => {
    expect(cosignRequirement(input({ thresholds: { low: 0, med: 0, high: 0 } }))).toBe(null);
  });
});

describe("cosignRequirement › a medium threshold above the high one", () => {
  const thresholds = { low: 0, med: 3, high: 2 };

  test("N reaches the medium threshold of a transaction before the removal", () => {
    expect(
      req({
        thresholds,
        transactions: [tx(0, "HANDLE_ASSETS"), ...DIRECT_CLOSE.map((t) => ({ ...t, order: 1 }))],
      })
    ).toMatchObject({ needed: 3, transactions: 2 });
  });

  test("with nothing before the removal, the high threshold decides", () => {
    expect(req({ thresholds })).toMatchObject({ needed: 2, transactions: 1 });
  });

  test("a claim-only round before the removal is held to the low threshold", () => {
    expect(
      req({
        thresholds: { low: 3, med: 0, high: 2 },
        transactions: [tx(0, "CLAIM_BALANCES"), ...DIRECT_CLOSE.map((t) => ({ ...t, order: 1 }))],
      }).needed
    ).toBe(3);
  });

  test("without a breakdown, the medium threshold counts", () => {
    expect(req({ thresholds, transactions: null }).needed).toBe(3);
  });

  test("with the master key required, its set reaches the medium threshold too", () => {
    expect(
      req({
        signers: [key(MASTER, 1), key(A, 5), key(B, 5)],
        thresholds: { low: 0, med: 10, high: 2 },
        transactions: [tx(0, "HANDLE_ASSETS"), tx(1, "NORMALIZE_SIGNERS"), tx(2, "MERGE")],
      })
    ).toMatchObject({ master: "required", needed: 3 });
  });
});

describe("cosignRequirement › the master key", () => {
  const signers = [key(MASTER, 1), key(A, 2), key(B, 2)];
  const thresholds = { low: 4, med: 4, high: 4 };
  const relayClose = [tx(0, "NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES"), tx(1, "MERGE")];

  test("removing signers without the merge makes the master key one of the N", () => {
    expect(req({ signers, thresholds, transactions: relayClose })).toMatchObject({
      master: "required",
      needed: 3,
    });
  });

  test("a removal in the merge transaction does not name the master key", () => {
    expect(req({ signers, thresholds })).toMatchObject({ master: "not-required", needed: 2 });
  });

  test("a batched close removes signers before its merge", () => {
    const batched = [
      tx(0, "NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES"),
      tx(1, "REMOVE_TRUSTLINES", "MERGE"),
    ];
    expect(req({ signers, thresholds, transactions: batched }).master).toBe("required");
  });

  test("without a breakdown, a relay close requires it and a direct close cannot tell", () => {
    expect(req({ signers, thresholds, transactions: null, viaRelay: true })).toMatchObject({
      master: "required",
      needed: 3,
    });
    expect(req({ signers, thresholds, transactions: null })).toMatchObject({
      master: "unknown",
      needed: 2,
    });
  });

  test("a master key that is enough with one other key still needs two", () => {
    expect(req({ signers: [key(MASTER, 1), key(A, 1)], transactions: relayClose })).toMatchObject({
      master: "required",
      needed: 2,
    });
  });
});

describe("cosignRequirement › K", () => {
  const token = tx(0, "HANDLE_ASSETS");
  const claim = tx(1, "CLAIM_BALANCES");
  const close = tx(2, "NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES", "MERGE");

  test("every transaction up to the removal counts when each needs more than one key", () => {
    expect(req({ transactions: [token, claim, close] }).transactions).toBe(3);
  });

  test("a transaction whose own threshold one key reaches is not counted", () => {
    expect(
      req({ transactions: [token, claim, close], thresholds: { low: 2, med: 1, high: 2 } })
        .transactions
    ).toBe(2);
    expect(
      req({ transactions: [token, claim, close], thresholds: { low: 0, med: 2, high: 2 } })
        .transactions
    ).toBe(2);
  });

  test("a claim round that adds a trustline is judged at the medium threshold", () => {
    const claimWithTrust = tx(1, "ADD_TRUSTLINE_FOR_CLAIM", "CLAIM_BALANCES");
    expect(
      req({ transactions: [claimWithTrust, close], thresholds: { low: 0, med: 2, high: 2 } })
        .transactions
    ).toBe(2);
  });

  test("a transaction whose own threshold the keys alone cannot reach is counted", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 1, type: "hash_x" },
    ];
    expect(
      req({ signers, transactions: [token, close], thresholds: { low: 0, med: 3, high: 2 } })
        .transactions
    ).toBe(2);
  });

  test("a transaction that names no step is judged at the medium threshold, not the low one", () => {
    expect(
      req({
        transactions: [tx(0), tx(1, "NORMALIZE_SIGNERS", "MERGE")],
        thresholds: { low: 0, med: 2, high: 2 },
      }).transactions
    ).toBe(2);
  });

  test("transactions after the removal need only the master key", () => {
    const batched = [
      tx(0, "NORMALIZE_SIGNERS", "REMOVE_TRUSTLINES"),
      tx(1, "REMOVE_TRUSTLINES"),
      tx(2, "MERGE"),
    ];
    expect(req({ transactions: batched }).transactions).toBe(1);
  });

  test("signer removal first and alone gives K = 1, whatever follows", () => {
    const removalFirst = [
      tx(0, "NORMALIZE_SIGNERS"),
      tx(1, "HANDLE_ASSETS"),
      tx(2, "CLAIM_BALANCES"),
      tx(3, "REMOVE_TRUSTLINES", "MERGE"),
    ];
    expect(req({ transactions: removalFirst })).toMatchObject({
      transactions: 1,
      master: "required",
    });
  });

  test("the breakdown's order field decides, not its array position", () => {
    expect(
      req({ transactions: [tx(1, "HANDLE_ASSETS"), tx(0, "NORMALIZE_SIGNERS")] }).transactions
    ).toBe(1);
  });

  test("no breakdown, or none that removes signers, gives no K", () => {
    expect(req({ transactions: null }).transactions).toBe(null);
    expect(req({ transactions: [tx(0, "HANDLE_ASSETS"), tx(1, "MERGE")] }).transactions).toBe(null);
  });
});

describe("cosignStatement", () => {
  const short = `${MASTER.slice(0, 8)}…${MASTER.slice(-8)}`;

  test("the statement with N, M and K", () => {
    expect(statement({ signers: [key(MASTER, 1), key(A, 1), key(B, 1), key(C, 1)] })).toBe(
      "This account needs signatures from at least 2 of its 4 keys, on 1 transaction of this close. These 2 must sign here, in this browser, during this close. Signing from another device is not supported yet."
    );
  });

  test("all of the keys, several transactions", () => {
    expect(
      statement({
        thresholds: { low: 3, med: 3, high: 3 },
        transactions: [tx(0, "HANDLE_ASSETS"), ...DIRECT_CLOSE.map((t) => ({ ...t, order: 1 }))],
      })
    ).toBe(
      "This account needs signatures from all 3 of its keys, on 2 transactions of this close. These 3 must sign here, in this browser, during this close. Signing from another device is not supported yet."
    );
  });

  test("without K, and with the master key conditional", () => {
    expect(statement({ transactions: null })).toBe(
      `This account needs signatures from at least 2 of its 3 keys for this close. These 2 must sign here, in this browser, during this close. If a transaction removes the other signers before the final transaction, the master key, ${short}, must sign it as well. Signing from another device is not supported yet.`
    );
  });

  test("names the master key when the removal does not merge", () => {
    expect(statement({ transactions: null, viaRelay: true })).toContain(
      `One transaction removes the other signers without closing the account, so the master key, ${short}, must be one of these 2. After it, the master key alone completes the close.`
    );
  });

  test("names each kind of non-key signer, singular and plural", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 1, type: "hash_x" },
      { key: PRE_AUTH, weight: 1, type: "preauth_tx" },
      { key: SIGNED_PAYLOAD, weight: 1, type: "ed25519_signed_payload" },
    ];
    const text = statement({ signers });
    expect(text).toContain(
      "It also has 1 hash(x) signer. A preimage is entered in this browser, and only on the step that removes its own signer."
    );
    expect(text).toContain(
      "It also has 1 pre-authorized transaction signer. It is used by submitting that exact transaction in this browser, not by signing."
    );
    expect(text).toContain("It also has 1 signed-payload signer, which cannot sign in LumenWipe.");
    expect(
      cosignStatement({ ...req({ signers }), preAuth: 2, hashX: 2, signedPayload: 2 }).join(" ")
    ).toContain("2 pre-authorized transaction signers. Each is used");
  });

  test("keys that cannot reach the threshold alone", () => {
    const signers: AccountSigner[] = [
      key(MASTER, 1),
      key(A, 1),
      { key: HASH_X, weight: 1, type: "hash_x" },
    ];
    expect(statement({ signers, thresholds: { low: 3, med: 3, high: 3 } })).toBe(
      "This account's keys alone cannot reach the signing weight this close needs. It also needs its hash(x) or pre-authorized transaction signers, used in this browser. Its keys must also sign here, in this browser, during this close. It also has 1 hash(x) signer. A preimage is entered in this browser, and only on the step that removes its own signer. Signing from another device is not supported yet."
    );
  });

  test("every variant passes the glossary and reads as the registered claim", () => {
    const variants: Partial<CosignInput>[] = [
      {},
      { transactions: null },
      { transactions: null, viaRelay: true },
      {
        signers: [key(MASTER, 1), key(A, 1), { key: HASH_X, weight: 1, type: "hash_x" }],
        thresholds: { low: 3, med: 3, high: 3 },
        viaRelay: true,
        transactions: null,
      },
    ];
    for (const v of variants) {
      const text = statement(v);
      expect(findBannedWords(text)).toEqual([]);
      expect(CLAIM_PATTERNS["same-browser-signing"].test(text)).toBe(true);
    }
  });
});
