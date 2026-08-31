import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { buildPlan } from "@/lib/stellar/tx-builder";
import type { AccountState, ClaimableBalance, SponsoredEntry, Trustline } from "@lumenwipe/types";

const MASTER_KP = Keypair.random();
const EXTRA_KP = Keypair.random();
const MASTER = MASTER_KP.publicKey();
const EXTRA = EXTRA_KP.publicKey();
const ISSUER = Keypair.random().publicKey();

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1234567890",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    ...overrides,
  };
}

function makeTrustline(code: string, balance = "0", authorized = true): Trustline {
  return {
    asset: `${code}:${ISSUER}`,
    balance,
    authorized,
    issuer: ISSUER,
    code,
  };
}

function makeClaimableBalance(asset: string, amount = "10.0000000"): ClaimableBalance {
  // Use a deterministic but structurally valid balance ID.
  const hash = asset
    .replace(/[^a-z0-9]/gi, "0")
    .padEnd(64, "0")
    .slice(0, 64);
  return {
    id: `00000000${hash}`,
    asset,
    amount,
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

// ─── Basic plan structure ────────────────────────────────────────────────────

test("buildPlan › clean account → single MERGE step", () => {
  const { steps: plan } = buildPlan(makeAccount(), false);
  expect(plan).toHaveLength(1);
  expect(plan[0].type).toBe("MERGE");
});

test("buildPlan › mediatorRequired=true → single MERGE step (shared mediator)", () => {
  const { steps: plan } = buildPlan(makeAccount(), true);
  expect(plan).toHaveLength(1);
  expect(plan[0].type).toBe("MERGE");
});

test("buildPlan › MERGE step title reflects the exchange route when mediator required", () => {
  const { steps: plan } = buildPlan(makeAccount(), true);
  const mergeStep = plan.find((s) => s.type === "MERGE")!;
  expect(mergeStep.title.toLowerCase()).toContain("exchange");
});

test("buildPlan › MERGE step direct title when no mediator", () => {
  const { steps: plan } = buildPlan(makeAccount(), false);
  const mergeStep = plan.find((s) => s.type === "MERGE")!;
  expect(mergeStep.title).toBe("Merge account");
});

test("buildPlan › extra signer → first step is NORMALIZE_SIGNERS", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › raised med threshold alone triggers NORMALIZE_SIGNERS", () => {
  const account = makeAccount({
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › raised high threshold alone triggers NORMALIZE_SIGNERS", () => {
  const account = makeAccount({
    thresholds: { low: 0, med: 1, high: 2 },
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › data entries → REMOVE_DATA_ENTRIES step", () => {
  const account = makeAccount({
    dataEntries: [
      { key: "key1", value: "dmFsdWU=" },
      { key: "key2", value: "dmFsdWU=" },
    ],
  });
  const { steps: plan } = buildPlan(account, false);
  const step = plan.find((s) => s.type === "REMOVE_DATA_ENTRIES");
  expect(step).toBeDefined();
  expect(step!.operationCount).toBe(2);
});

test("buildPlan › 101 data entries → 2 REMOVE_DATA_ENTRIES batches", () => {
  const account = makeAccount({
    dataEntries: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, value: "" })),
  });
  const { steps: plan } = buildPlan(account, false);
  const steps = plan.filter((s) => s.type === "REMOVE_DATA_ENTRIES");
  expect(steps).toHaveLength(2);
  expect(steps[0].operationCount).toBe(100);
  expect(steps[1].operationCount).toBe(1);
});

test("buildPlan › open offers → CANCEL_OFFERS step", () => {
  const account = makeAccount({
    openOffers: [
      { id: "1", selling: "native", buying: "USDC:GABC", amount: "100", price: "1.0" },
      { id: "2", selling: "native", buying: "BTC:GABC", amount: "10", price: "0.5" },
    ],
  });
  const { steps: plan } = buildPlan(account, false);
  const step = plan.find((s) => s.type === "CANCEL_OFFERS");
  expect(step).toBeDefined();
  expect(step!.operationCount).toBe(2);
});

test("buildPlan › trustline with balance → HANDLE_ASSETS before REMOVE_TRUSTLINES", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "100.0")] });
  const { steps: plan } = buildPlan(account, false);
  const convertIdx = plan.findIndex((s) => s.type === "HANDLE_ASSETS");
  const removeIdx = plan.findIndex((s) => s.type === "REMOVE_TRUSTLINES");
  expect(convertIdx).toBeGreaterThanOrEqual(0);
  expect(removeIdx).toBeGreaterThanOrEqual(0);
  expect(convertIdx).toBeLessThan(removeIdx);
});

test("buildPlan › HANDLE_ASSETS step includes affectedAsset", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0")] });
  const { steps: plan } = buildPlan(account, false);
  const step = plan.find((s) => s.type === "HANDLE_ASSETS");
  expect(step!.affectedAsset).toBe(`USDC:${ISSUER}`);
});

test("buildPlan › trustline with zero balance → no HANDLE_ASSETS", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.find((s) => s.type === "HANDLE_ASSETS")).toBeUndefined();
});

test("buildPlan › trustline with zero balance → still has REMOVE_TRUSTLINES", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.find((s) => s.type === "REMOVE_TRUSTLINES")).toBeDefined();
});

test("buildPlan › step indices are sequential from 0", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k1", value: "" }],
    openOffers: [{ id: "1", selling: "native", buying: "USDC:G", amount: "1", price: "1" }],
  });
  const { steps: plan } = buildPlan(account, false);
  plan.forEach((step, i) => {
    expect(step.index).toBe(i);
  });
});

test("buildPlan › all steps start with status 'pending'", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k1", value: "" }],
    trustlines: [makeTrustline("USDC", "0")],
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.every((s) => s.status === "pending")).toBe(true);
});

test("buildPlan › all steps have non-null estimatedFeeLumens", () => {
  const { steps: plan } = buildPlan(makeAccount(), false);
  expect(plan.every((s) => s.estimatedFeeLumens !== null)).toBe(true);
  expect(plan.every((s) => parseFloat(s.estimatedFeeLumens) > 0)).toBe(true);
});

test("buildPlan › all steps have txXdr=null initially", () => {
  const { steps: plan } = buildPlan(makeAccount(), false);
  expect(plan.every((s) => s.txXdr === null)).toBe(true);
});

test("buildPlan › complex account has all expected step types", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
    dataEntries: [{ key: "k1", value: "" }],
    openOffers: [{ id: "1", selling: "native", buying: "USDC:G", amount: "1", price: "1" }],
    trustlines: [makeTrustline("USDC", "50.0")],
  });
  const { steps: plan } = buildPlan(account, false);
  const types = plan.map((s) => s.type);
  expect(types).toContain("NORMALIZE_SIGNERS");
  expect(types).toContain("REMOVE_DATA_ENTRIES");
  expect(types).toContain("CANCEL_OFFERS");
  expect(types).toContain("HANDLE_ASSETS");
  expect(types).toContain("REMOVE_TRUSTLINES");
  expect(types).toContain("MERGE");
});

test("buildPlan › 5 trustlines with balance → 5 HANDLE_ASSETS steps + 1 REMOVE_TRUSTLINES", () => {
  const account = makeAccount({
    trustlines: Array.from({ length: 5 }, (_, i) => makeTrustline(`TK${i}`, "10.0")),
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.filter((s) => s.type === "HANDLE_ASSETS")).toHaveLength(5);
  expect(plan.filter((s) => s.type === "REMOVE_TRUSTLINES")).toHaveLength(1);
});

// ─── Signer type tests ───────────────────────────────────────────────────────

test("buildPlan › hash_x extra signer → NORMALIZE_SIGNERS step", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: "XHASH00000000000000000000000000000000000000000000000000000",
        weight: 1,
        type: "hash_x",
      },
    ],
  });
  const { steps } = buildPlan(account, false);
  expect(steps[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › preauth_tx extra signer → NORMALIZE_SIGNERS step", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: "TPREAUTH0000000000000000000000000000000000000000000000000",
        weight: 1,
        type: "preauth_tx",
      },
    ],
  });
  const { steps } = buildPlan(account, false);
  expect(steps[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › ed25519_signed_payload extra signer → NORMALIZE_SIGNERS step", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: "PSIGNEDPAYLOAD0000000000000000000000000000000000000000000000000000000000000",
        weight: 1,
        type: "ed25519_signed_payload",
      },
    ],
  });
  const { steps } = buildPlan(account, false);
  expect(steps[0].type).toBe("NORMALIZE_SIGNERS");
});

// ─── Existing blocker tests ──────────────────────────────────────────────────

test("buildPlan › clean account → no blockers", () => {
  const { blockers } = buildPlan(makeAccount(), false);
  expect(blockers).toHaveLength(0);
});

test("buildPlan › combined signer weight meets high threshold → no blocker even if master alone falls short", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 5, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 3, high: 5 },
  });
  const { steps, blockers } = buildPlan(account, false);
  expect(blockers).toHaveLength(0);
  expect(steps.some((s) => s.type === "NORMALIZE_SIGNERS")).toBe(true);
});

test("buildPlan › combined satisfiable signer weight below high threshold → blocker", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 2, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 3, high: 5 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].message).toContain("high threshold");
});

test("buildPlan › a signed-payload signer's weight never counts toward the combined total (genuinely unsatisfiable)", () => {
  const signedPayloadKey = "PA" + "A".repeat(103); // shape only; buildPlan doesn't validate strkeys
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: signedPayloadKey, weight: 10, type: "ed25519_signed_payload" },
    ],
    thresholds: { low: 0, med: 3, high: 5 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].message).toContain("high threshold");
});

test("buildPlan › identical combined weight blocks or doesn't purely based on whether the extra signer's type is satisfiable", () => {
  const thresholds = { low: 0, med: 3, high: 5 };
  const signedPayloadKey = "PA" + "A".repeat(103); // shape only; buildPlan doesn't validate strkeys

  const withSignedPayload = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: signedPayloadKey, weight: 10, type: "ed25519_signed_payload" },
    ],
    thresholds,
  });
  expect(buildPlan(withSignedPayload, false).blockers).toHaveLength(1);

  const withEd25519 = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 10, type: "ed25519_public_key" }, // same weight, only the type changed
    ],
    thresholds,
  });
  expect(buildPlan(withEd25519, false).blockers).toHaveLength(0);
});

test("buildPlan › master weight meets high threshold → no threshold blocker", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 5, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 3, high: 5 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers).toHaveLength(0);
});

test("buildPlan › master key weight 0, satisfiable co-signer weight alone meets threshold → still blocked (normalization would strip the only usable signer)", () => {
  // signerNormalizationOps always removes every non-master signer and resets thresholds to
  // 0/1/1, but never raises masterWeight. If the master key is weight 0 and the account
  // proceeds because *combined* weight clears the threshold, normalization leaves an
  // account with a weight-0 master key and threshold 1 - no signer can authorize anything.
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 0, type: "ed25519_public_key" },
      { key: EXTRA, weight: 5, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 5, high: 5 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("weight 0"))).toBe(true);
});

test("buildPlan › numSponsoring > 0 → blocker emitted", () => {
  const { blockers } = buildPlan(makeAccount({ numSponsoring: 2 }), false);
  expect(blockers.some((b) => b.message.includes("sponsoring"))).toBe(true);
});

test("buildPlan › numSponsoring = 0 → no sponsoring blocker", () => {
  const { blockers } = buildPlan(makeAccount({ numSponsoring: 0 }), false);
  expect(blockers.every((b) => !b.message.includes("sponsoring"))).toBe(true);
});

test("buildPlan › pool shares present → blocker emitted", () => {
  const account = makeAccount({ poolShares: [{ poolId: "a".repeat(64) }] });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("pool"))).toBe(true);
});

test("buildPlan › no pool shares → no pool blocker", () => {
  const { blockers } = buildPlan(makeAccount(), false);
  expect(blockers.every((b) => !b.message.includes("pool"))).toBe(true);
});

test("buildPlan › subEntryMismatch → blocker emitted", () => {
  const { blockers } = buildPlan(makeAccount({ subEntryMismatch: true }), false);
  expect(blockers.some((b) => b.message.includes("entries that could not be enumerated"))).toBe(
    true
  );
});

test("buildPlan › subEntryMismatch false → no mismatch blocker", () => {
  const { blockers } = buildPlan(makeAccount({ subEntryMismatch: false }), false);
  expect(blockers.every((b) => !b.message.includes("enumerated"))).toBe(true);
});

// ─── AUTH_IMMUTABLE blocker ──────────────────────────────────────────────────

test("buildPlan › authImmutable=true → blocker emitted", () => {
  const { blockers } = buildPlan(makeAccount({ authImmutable: true }), false);
  expect(blockers.some((b) => b.message.includes("AUTH_IMMUTABLE"))).toBe(true);
});

test("buildPlan › authImmutable=false → no AUTH_IMMUTABLE blocker", () => {
  const { blockers } = buildPlan(makeAccount({ authImmutable: false }), false);
  expect(blockers.every((b) => !b.message.includes("AUTH_IMMUTABLE"))).toBe(true);
});

test("buildPlan › authImmutable=true → steps still generated for display", () => {
  // The UI decides whether to block execution; the plan is built so users can see
  // the account contents even when a hard blocker is present.
  const { steps } = buildPlan(makeAccount({ authImmutable: true }), false);
  expect(steps.some((s) => s.type === "MERGE")).toBe(true);
});

// ─── Deauthorized trustline blocker ─────────────────────────────────────────

test("buildPlan › deauthorized trustline with balance → blocker per trustline", () => {
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "50.0", false), makeTrustline("BTC", "1.0", false)],
  });
  const { blockers } = buildPlan(account, false);
  const deauthBlockers = blockers.filter((b) => b.message.includes("deauthorized"));
  expect(deauthBlockers).toHaveLength(2);
  expect(deauthBlockers[0].message).toContain("USDC");
  expect(deauthBlockers[1].message).toContain("BTC");
});

test("buildPlan › deauthorized trustline with ZERO balance → no blocker", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0", false)] });
  const { blockers } = buildPlan(account, false);
  expect(blockers.every((b) => !b.message.includes("deauthorized"))).toBe(true);
});

test("buildPlan › deauthorized trustline with balance → no HANDLE_ASSETS for that asset", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0", false)] });
  const { steps } = buildPlan(account, false);
  // A deauthorized trustline cannot be converted - no HANDLE_ASSETS should be emitted for it.
  expect(steps.find((s) => s.type === "HANDLE_ASSETS")).toBeUndefined();
});

test("buildPlan › deauthorized trustline with balance → REMOVE_TRUSTLINES still present", () => {
  // The plan includes REMOVE_TRUSTLINES so the user can see what needs clearing once
  // the issuer re-authorizes; the blocker prevents actual execution.
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0", false)] });
  const { steps } = buildPlan(account, false);
  expect(steps.find((s) => s.type === "REMOVE_TRUSTLINES")).toBeDefined();
});

test("buildPlan › authorized and deauthorized trustlines mixed → only authorized gets HANDLE_ASSETS", () => {
  const account = makeAccount({
    trustlines: [
      makeTrustline("USDC", "100.0", true), // authorized with balance
      makeTrustline("BTC", "1.0", false), // deauthorized with balance - blocked
    ],
  });
  const { steps, blockers } = buildPlan(account, false);
  const convertSteps = steps.filter((s) => s.type === "HANDLE_ASSETS");
  expect(convertSteps).toHaveLength(1);
  expect(convertSteps[0].affectedAsset).toBe(`USDC:${ISSUER}`);
  expect(
    blockers.some((b) => b.message.includes("deauthorized") && b.message.includes("BTC"))
  ).toBe(true);
});

// ─── Claimable balance steps ─────────────────────────────────────────────────

test("buildPlan › XLM claimable balance → CLAIM_BALANCES step", () => {
  const account = makeAccount({ claimableBalances: [makeClaimableBalance("native")] });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "CLAIM_BALANCES")).toBe(true);
});

test("buildPlan › claimable balance for asset with authorized trustline → CLAIM_BALANCES step", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)],
    claimableBalances: [makeClaimableBalance(asset)],
  });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "CLAIM_BALANCES")).toBe(true);
});

test("buildPlan › claimable balance for asset with no trustline → blocker, no CLAIM_BALANCES", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [], // no trustline for USDC
    claimableBalances: [makeClaimableBalance(asset)],
  });
  const { steps, blockers } = buildPlan(account, false);
  expect(steps.every((s) => s.type !== "CLAIM_BALANCES")).toBe(true);
  expect(blockers.some((b) => b.message.includes("USDC") && b.message.includes("trustline"))).toBe(
    true
  );
});

test("buildPlan › claimable balance for asset with deauthorized trustline → blocker", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", false)], // deauthorized
    claimableBalances: [makeClaimableBalance(asset)],
  });
  const { steps, blockers } = buildPlan(account, false);
  expect(steps.every((s) => s.type !== "CLAIM_BALANCES")).toBe(true);
  expect(blockers.some((b) => b.message.includes("USDC") && b.message.includes("trustline"))).toBe(
    true
  );
});

// ─── Claimable balance selections (issue #70) ────────────────────────────────

test("buildPlan › currently-claimable balance opted out (forfeit) → excluded from any step, no blocker", () => {
  const asset = `USDC:${ISSUER}`;
  const balance = makeClaimableBalance(asset);
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)],
    claimableBalances: [balance],
  });
  const { steps, blockers } = buildPlan(account, false, false, { [balance.id]: "forfeit" });
  expect(steps.every((s) => s.type !== "CLAIM_BALANCES")).toBe(true);
  expect(blockers).toHaveLength(0);
});

test("buildPlan › unclaimable balance with add_trustline_then_claim → ADD_TRUSTLINE_FOR_CLAIM precedes CLAIM_BALANCES", () => {
  const asset = `USDC:${ISSUER}`;
  const balance = makeClaimableBalance(asset);
  const account = makeAccount({ claimableBalances: [balance] });
  const { steps, blockers } = buildPlan(account, false, false, {
    [balance.id]: "add_trustline_then_claim",
  });
  expect(blockers).toHaveLength(0);
  const addTrustlineIdx = steps.findIndex((s) => s.type === "ADD_TRUSTLINE_FOR_CLAIM");
  const claimIdx = steps.findIndex((s) => s.type === "CLAIM_BALANCES");
  expect(addTrustlineIdx).toBeGreaterThanOrEqual(0);
  expect(claimIdx).toBeGreaterThan(addTrustlineIdx);
});

test("buildPlan › unclaimable balance with forfeit → blocker says forfeit, not establish a trustline", () => {
  const asset = `USDC:${ISSUER}`;
  const balance = makeClaimableBalance(asset);
  const account = makeAccount({ claimableBalances: [balance] });
  const { steps, blockers } = buildPlan(account, false, false, { [balance.id]: "forfeit" });
  expect(
    steps.every((s) => s.type !== "CLAIM_BALANCES" && s.type !== "ADD_TRUSTLINE_FOR_CLAIM")
  ).toBe(true);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("claimable_balance_forfeited");
  expect(blockers[0].message).toContain("forfeit");
  expect(blockers[0].message).not.toContain("Establish");
});

test("buildPlan › unresolved unclaimable balance (no selection) → unchanged blocker behavior", () => {
  const asset = `USDC:${ISSUER}`;
  const balance = makeClaimableBalance(asset);
  const account = makeAccount({ claimableBalances: [balance] });
  const { steps, blockers } = buildPlan(account, false);
  expect(
    steps.every((s) => s.type !== "CLAIM_BALANCES" && s.type !== "ADD_TRUSTLINE_FOR_CLAIM")
  ).toBe(true);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("claimable_balance_unclaimable");
  expect(blockers[0].message).toContain("Establish");
});

test("buildPlan › CLAIM_BALANCES comes after CANCEL_OFFERS and before HANDLE_ASSETS", () => {
  const account = makeAccount({
    openOffers: [{ id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" }],
    claimableBalances: [makeClaimableBalance("native")],
  });
  const { steps } = buildPlan(account, false);
  const cancelIdx = steps.findIndex((s) => s.type === "CANCEL_OFFERS");
  const claimIdx = steps.findIndex((s) => s.type === "CLAIM_BALANCES");
  expect(claimIdx).toBeGreaterThan(cancelIdx);
});

test("buildPlan › 101 XLM claimable balances → 2 CLAIM_BALANCES batches", () => {
  const account = makeAccount({
    claimableBalances: Array.from({ length: 101 }, (_, i) => ({
      id: `00000000${"0".repeat(63)}${i.toString(16).slice(-1)}`,
      asset: "native",
      amount: "1.0000000",
      claimants: [{ destination: MASTER, predicate: { type: "unconditional" as const } }],
      sponsor: null,
    })),
  });
  const { steps } = buildPlan(account, false);
  const claimSteps = steps.filter((s) => s.type === "CLAIM_BALANCES");
  expect(claimSteps).toHaveLength(2);
  expect(claimSteps[0].operationCount).toBe(100);
  expect(claimSteps[1].operationCount).toBe(1);
});

test("buildPlan › no claimable balances → no CLAIM_BALANCES step", () => {
  const { steps } = buildPlan(makeAccount(), false);
  expect(steps.every((s) => s.type !== "CLAIM_BALANCES")).toBe(true);
});

// ─── Claimable balance + trustline interaction ───────────────────────────────

test("buildPlan › zero-balance trustline with claimable balance for same asset → HANDLE_ASSETS included", () => {
  // After claiming, the trustline will have balance. HANDLE_ASSETS must be in the plan
  // so REMOVE_TRUSTLINES doesn't fail with change_trust_cannot_delete.
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)], // zero balance now
    claimableBalances: [makeClaimableBalance(asset, "50.0")], // will add 50 USDC after claiming
  });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "CLAIM_BALANCES")).toBe(true);
  expect(steps.some((s) => s.type === "HANDLE_ASSETS" && s.affectedAsset === asset)).toBe(true);
});

test("buildPlan › CLAIM_BALANCES comes before HANDLE_ASSETS for same asset", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)],
    claimableBalances: [makeClaimableBalance(asset, "50.0")],
  });
  const { steps } = buildPlan(account, false);
  const claimIdx = steps.findIndex((s) => s.type === "CLAIM_BALANCES");
  const convertIdx = steps.findIndex((s) => s.type === "HANDLE_ASSETS");
  expect(claimIdx).toBeGreaterThanOrEqual(0);
  expect(convertIdx).toBeGreaterThanOrEqual(0);
  expect(claimIdx).toBeLessThan(convertIdx);
});

// ─── Fast-path tests ─────────────────────────────────────────────────────────

test("buildPlan › fastPathEligible + cleanup + direct → single CLOSE_ACCOUNT step", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    trustlines: [makeTrustline("USDC", "0")],
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps).toHaveLength(1);
  expect(steps[0].type).toBe("CLOSE_ACCOUNT");
});

test("buildPlan › fastPathEligible + cleanup + exchange → CLOSE_ACCOUNT then MERGE", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, true, true);
  expect(steps.map((s) => s.type)).toEqual(["CLOSE_ACCOUNT", "MERGE"]);
});

test("buildPlan › fastPathEligible but clean account → single MERGE (nothing to fuse)", () => {
  const { steps } = buildPlan(makeAccount(), false, true);
  expect(steps).toHaveLength(1);
  expect(steps[0].type).toBe("MERGE");
});

test("buildPlan › fastPathEligible but blocker present → falls back to stepwise", () => {
  const account = makeAccount({ numSponsoring: 1, dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, false, true);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
  expect(steps.some((s) => s.type === "REMOVE_DATA_ENTRIES")).toBe(true);
});

test("buildPlan › fastPathEligible but claimable balances present → falls back to stepwise", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    claimableBalances: [makeClaimableBalance("native")],
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
  expect(steps.some((s) => s.type === "CLAIM_BALANCES")).toBe(true);
});

test("buildPlan › fastPathEligible but >100 fused ops → falls back to stepwise", () => {
  const account = makeAccount({
    dataEntries: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, value: "" })),
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
});

test("buildPlan › default (no fastPath arg) is unchanged stepwise plan", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
});

test("buildPlan › fastPathEligible + multiple balance-bearing assets → single CLOSE_ACCOUNT", () => {
  // The fused step is disposition-agnostic: buildPlan counts one op per asset-with-balance
  // regardless of whether each asset is later swapped to XLM or returned to its issuer.
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "10"), makeTrustline("EURC", "5")],
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps).toHaveLength(1);
  expect(steps[0].type).toBe("CLOSE_ACCOUNT");
});

test("buildPlan › CLOSE_ACCOUNT operationCount counts one op per balance-bearing asset", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    trustlines: [makeTrustline("USDC", "10"), makeTrustline("EURC", "5")],
  });
  const { steps } = buildPlan(account, false, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT")!;
  // 1 data + 2 asset ops (one per balance-bearing trustline) + 2 trustline removals + 1 merge = 6
  expect(close.operationCount).toBe(6);
});

test("buildPlan › CLOSE_ACCOUNT operationCount sums all fused ops", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    openOffers: [{ id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" }],
  });
  const { steps } = buildPlan(account, false, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT")!;
  // 1 data + 1 offer + 1 merge = 3
  expect(close.operationCount).toBe(3);
});

// ─── Sponsorship affordability (issue #72) ───────────────────────────────────

const SPONSORED_OWNER = Keypair.random().publicKey();

test("buildPlan › affordable sponsored entry → REVOKE_SPONSORSHIP step, no sponsoring blocker", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [entry],
      unaffordableOwners: new Map(),
    }
  );
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(true);
  expect(blockers.some((b) => b.message.toLowerCase().includes("sponsor"))).toBe(false);
});

test("buildPlan › unaffordable sponsored entry → per-owner blocker, no REVOKE_SPONSORSHIP step", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map([
        [SPONSORED_OWNER, { entries: [entry], shortfallXlm: "0.5000000" }],
      ]),
    }
  );
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.message.includes("0.5000000"))).toBe(true);
});

test("buildPlan › mixed affordable + unaffordable owners → partial resolution, not all-or-nothing", () => {
  const affordableOwner = Keypair.random().publicKey();
  const affordableEntry: SponsoredEntry = {
    kind: "trustline",
    owner: affordableOwner,
    asset: `USDC:${ISSUER}`,
  };
  const unaffordableEntry: SponsoredEntry = {
    kind: "signer",
    owner: SPONSORED_OWNER,
    signerKey: Keypair.random().publicKey(),
  };
  const account = makeAccount({
    numSponsoring: 2,
    sponsoredEntries: [affordableEntry, unaffordableEntry],
  });
  const { steps, blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [affordableEntry],
      unaffordableOwners: new Map([
        [SPONSORED_OWNER, { entries: [unaffordableEntry], shortfallXlm: "0.5000000" }],
      ]),
    }
  );
  const revokeStep = steps.find((s) => s.type === "REVOKE_SPONSORSHIP");
  expect(revokeStep?.operationCount).toBe(1); // only the affordable one
  expect(blockers).toHaveLength(1);
});

test("buildPlan › sponsorshipEnumerationIncomplete → old blanket blocker, ignores affordability result", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({
    numSponsoring: 1,
    sponsoredEntries: [entry],
    sponsorshipEnumerationIncomplete: true,
  });
  const { steps, blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [entry], // even though the caller says it's affordable, incompleteness wins
      unaffordableOwners: new Map(),
    }
  );
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.message.includes("sponsoring 1 entr"))).toBe(true);
});

test("buildPlan › claimable-balance sponsorship is always a permanent blocker, never a step", () => {
  const entry: SponsoredEntry = {
    kind: "claimable_balance",
    balanceId: "00000000" + "ab".repeat(32),
  };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map(),
    }
  );
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.code === "sponsorship_claimable_balance_unrevocable")).toBe(true);
});

test("buildPlan › numSponsoring > 0 but no entries found (defensive fallback) → old blanket blocker", () => {
  // Existing behavior preserved: a numSponsoring/sponsoredEntries disagreement even when
  // enumeration claims complete must never silently resolve to "nothing to do."
  const { blockers } = buildPlan(makeAccount({ numSponsoring: 2 }), false);
  expect(blockers.some((b) => b.message.includes("sponsoring"))).toBe(true);
});

// ─── Step indices are sequential across every step type (idx++, not idx--) ───

test("buildPlan › step indices are sequential from 0 across every non-fast-path step type", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
    numSponsoring: 1,
    sponsoredEntries: [entry],
    dataEntries: [{ key: "k", value: "" }],
    openOffers: [{ id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" }],
    claimableBalances: [makeClaimableBalance(`EURC:${ISSUER}`)],
    trustlines: [makeTrustline("EURC", "10"), makeTrustline("USDC", "5")],
  });
  const { steps } = buildPlan(
    account,
    false,
    false,
    { [makeClaimableBalance(`EURC:${ISSUER}`).id]: "add_trustline_then_claim" },
    { revocable: [entry], unaffordableOwners: new Map() }
  );
  expect(steps.length).toBeGreaterThan(5);
  steps.forEach((s, i) => expect(s.index).toBe(i));
});

test("buildPlan › step indices are sequential from 0 on the fast path (both CLOSE_ACCOUNT and MERGE)", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, true, true);
  expect(steps).toHaveLength(2);
  steps.forEach((s, i) => expect(s.index).toBe(i));
});

// ─── Helper functions: shortAddr and describeSponsoredEntry (via the unaffordable-owner blocker) ─

test("buildPlan › unaffordable-owner blocker names the entry kind and shortens the owner address", () => {
  const owner = Keypair.random().publicKey();
  const entry: SponsoredEntry = { kind: "account", owner };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map([[owner, { entries: [entry], shortfallXlm: "1.5000000" }]]),
    }
  );
  const b = blockers.find((x) => x.code === "sponsorship_unaffordable")!;
  expect(b.message).toBe(
    `Revoking sponsorship of an account creation on ${owner.slice(0, 8)}…${owner.slice(-8)} would ` +
      `leave that account below its minimum balance - it needs 1.5000000 more XLM first.`
  );
});

test.each([
  ["account" as const, {}, "an account creation"],
  ["trustline" as const, { asset: `USDC:${ISSUER}` }, "a trustline for USDC"],
  ["offer" as const, { offerId: "42" }, "offer 42"],
  ["data_entry" as const, { name: "memo" }, 'data entry "memo"'],
  ["signer" as const, { signerKey: "GABC" }, "a signer"],
])("buildPlan › describes a %s sponsored entry as %j -> %s", (kind, fields, expected) => {
  const owner = Keypair.random().publicKey();
  const entry = { kind, owner, ...fields } as SponsoredEntry;
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map([[owner, { entries: [entry], shortfallXlm: "1.0000000" }]]),
    }
  );
  const b = blockers.find((x) => x.code === "sponsorship_unaffordable")!;
  expect(b.message).toContain(expected);
});

// ─── Sponsoring blanket-blocker pluralization ─────────────────────────────────

test("buildPlan › blanket sponsorship blocker says 'entry' (singular) for exactly one", () => {
  const { blockers } = buildPlan(
    makeAccount({ numSponsoring: 1, sponsorshipEnumerationIncomplete: true }),
    false
  );
  const b = blockers.find((x) => x.message.includes("sponsoring"))!;
  expect(b.message).toBe(
    "This account is sponsoring 1 entry on other accounts. All sponsorships must be revoked before the account can be merged."
  );
});

test("buildPlan › blanket sponsorship blocker says 'entries' (plural) for more than one", () => {
  const { blockers } = buildPlan(
    makeAccount({ numSponsoring: 3, sponsorshipEnumerationIncomplete: true }),
    false
  );
  const b = blockers.find((x) => x.message.includes("sponsoring"))!;
  expect(b.message).toBe(
    "This account is sponsoring 3 entries on other accounts. All sponsorships must be revoked before the account can be merged."
  );
});

// ─── NORMALIZE_SIGNERS step content ───────────────────────────────────────────

test("buildPlan › NORMALIZE_SIGNERS title, description and operationCount are exact", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "NORMALIZE_SIGNERS")!;
  expect(s.title).toBe("Remove extra signers");
  expect(s.description).toBe(
    "Remove 1 additional signer(s) and reset authorization thresholds so this key alone can authorize transactions."
  );
  expect(s.operationCount).toBe(2); // 1 extra signer removal + 1 threshold reset
});

// ─── Signer-threshold blockers: exact boundaries and messages ─────────────────

test("buildPlan › master key at weight 0 is always blocked, regardless of co-signer weight", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 0, type: "ed25519_public_key" },
      { key: EXTRA, weight: 10, type: "ed25519_public_key" },
    ],
    thresholds: { low: 0, med: 1, high: 1 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("weight 0"))).toBe(true);
});

test("buildPlan › master key entirely absent from the signers list is treated as weight 0, not a crash", () => {
  // Defensive: `signers.find(...)?.weight ?? 0` - if the master key is somehow not in its own
  // signers list, this must default to 0 (blocked) rather than throw on `.weight` of undefined.
  const account = makeAccount({
    signers: [{ key: EXTRA, weight: 1, type: "ed25519_public_key" }],
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("weight 0"))).toBe(true);
});

test("buildPlan › a weight-0 master key with no extra signers and no raised thresholds needs no normalization, so the section (and its blocker) is skipped entirely", () => {
  const account = makeAccount({
    signers: [{ key: MASTER, weight: 0, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers).toHaveLength(0);
});

test("buildPlan › master key at weight 1 (not 0) is not blocked on that ground alone", () => {
  const account = makeAccount({
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("weight 0"))).toBe(false);
});

test("buildPlan › satisfiable weight exactly meeting the high threshold is not blocked", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "hash_x" },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("can contribute at most"))).toBe(false);
});

test("buildPlan › satisfiable weight one below the high threshold is blocked, exact message when it equals total weight", () => {
  const account = makeAccount({
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  const b = blockers.find((x) => x.message.includes("can contribute at most"))!;
  expect(b.message).toBe(
    "This account's signers can contribute at most weight 1 toward removing signers or changing " +
      "thresholds, but that requires weight 2 (the current high threshold)."
  );
});

test("buildPlan › satisfiable weight below threshold, with an unsatisfiable signer, names that fact explicitly", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 5, type: "ed25519_signed_payload" }, // never satisfiable
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  const b = blockers.find((x) => x.message.includes("can contribute at most"))!;
  expect(b.message).toContain("At least one of its signers cannot be authorized through this flow");
});

// ─── Batch loops: title suffix, pluralization, and the zero-item gate, per step type ──

test("buildPlan › a single REVOKE_SPONSORSHIP batch has no '(batch n/m)' suffix and singular wording for one entry", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [entry],
      unaffordableOwners: new Map(),
    }
  );
  const s = steps.find((x) => x.type === "REVOKE_SPONSORSHIP")!;
  expect(s.title).toBe("Revoke sponsorships");
  expect(s.description).toBe(
    "Transfer reserve responsibility for 1 sponsored entry back to their own accounts."
  );
});

test("buildPlan › 101 revocable sponsorships → 2 REVOKE_SPONSORSHIP batches, titled and worded exactly", () => {
  const entries: SponsoredEntry[] = Array.from({ length: 101 }, (_, i) => ({
    kind: "trustline" as const,
    owner: SPONSORED_OWNER,
    asset: `T${i}:${ISSUER}`,
  }));
  const account = makeAccount({ numSponsoring: 101, sponsoredEntries: entries });
  const { steps } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: entries,
      unaffordableOwners: new Map(),
    }
  );
  const batches = steps.filter((x) => x.type === "REVOKE_SPONSORSHIP");
  expect(batches).toHaveLength(2);
  expect(batches[0]!.title).toBe("Revoke sponsorships (batch 1/2)");
  expect(batches[0]!.description).toBe(
    "Transfer reserve responsibility for 100 sponsored entries back to their own accounts."
  );
  expect(batches[1]!.title).toBe("Revoke sponsorships (batch 2/2)");
  expect(batches[1]!.description).toBe(
    "Transfer reserve responsibility for 1 sponsored entry back to their own accounts."
  );
});

test("buildPlan › a single REMOVE_DATA_ENTRIES batch has no batch suffix, singular wording for one entry", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "REMOVE_DATA_ENTRIES")!;
  expect(s.title).toBe("Remove data entries");
  expect(s.description).toBe("Clear 1 data entry stored on this account.");
});

test("buildPlan › 101 data entries → batch titles and wording are exact", () => {
  const account = makeAccount({
    dataEntries: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, value: "" })),
  });
  const { steps } = buildPlan(account, false);
  const batches = steps.filter((x) => x.type === "REMOVE_DATA_ENTRIES");
  expect(batches[0]!.title).toBe("Remove data entries (batch 1/2)");
  expect(batches[0]!.description).toBe("Clear 100 data entries stored on this account.");
  expect(batches[1]!.title).toBe("Remove data entries (batch 2/2)");
  expect(batches[1]!.description).toBe("Clear 1 data entry stored on this account.");
});

test("buildPlan › a single CANCEL_OFFERS batch has no batch suffix, singular wording for one offer", () => {
  const account = makeAccount({
    openOffers: [{ id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" }],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CANCEL_OFFERS")!;
  expect(s.title).toBe("Cancel open DEX offers");
  expect(s.description).toBe("Cancel 1 open offer on the Stellar DEX.");
});

test("buildPlan › 101 offers → batch titles and wording are exact", () => {
  const account = makeAccount({
    openOffers: Array.from({ length: 101 }, (_, i) => ({
      id: `${i}`,
      selling: "native",
      buying: `USDC:${ISSUER}`,
      amount: "1",
      price: "1",
    })),
  });
  const { steps } = buildPlan(account, false);
  const batches = steps.filter((x) => x.type === "CANCEL_OFFERS");
  expect(batches[0]!.title).toBe("Cancel DEX offers (batch 1/2)");
  expect(batches[0]!.description).toBe("Cancel 100 open offers on the Stellar DEX.");
  expect(batches[1]!.title).toBe("Cancel DEX offers (batch 2/2)");
  expect(batches[1]!.description).toBe("Cancel 1 open offer on the Stellar DEX.");
});

test("buildPlan › a single ADD_TRUSTLINE_FOR_CLAIM batch has no batch suffix, singular wording for one balance", () => {
  const cb = makeClaimableBalance(`USDC:${ISSUER}`);
  const account = makeAccount({ claimableBalances: [cb] });
  const { steps } = buildPlan(account, false, false, { [cb.id]: "add_trustline_then_claim" });
  const s = steps.find((x) => x.type === "ADD_TRUSTLINE_FOR_CLAIM")!;
  expect(s.title).toBe("Add trustlines to claim");
  expect(s.description).toBe(
    "Establish 1 trustline so the following claimable balance can be claimed."
  );
});

test("buildPlan › ADD_TRUSTLINE_FOR_CLAIM step index is sequential with the steps around it", () => {
  // This used to expect ADD_TRUSTLINE -> CLAIM -> MERGE, and so encoded the defect rather than
  // catching it: that plan merges an account still holding the trustline it just opened and the
  // balance it just claimed, which the network rejects. Handling the arriving asset and removing
  // the line the plan itself added belong to the same close.
  const cb = makeClaimableBalance(`USDC:${ISSUER}`);
  const account = makeAccount({ claimableBalances: [cb] });
  const { steps } = buildPlan(account, false, false, { [cb.id]: "add_trustline_then_claim" });
  expect(steps.map((s) => s.type)).toEqual([
    "ADD_TRUSTLINE_FOR_CLAIM",
    "CLAIM_BALANCES",
    "HANDLE_ASSETS",
    "REMOVE_TRUSTLINES",
    "MERGE",
  ]);
  steps.forEach((s, i) => expect(s.index).toBe(i));
});

test("buildPlan › 101 remediated balances → ADD_TRUSTLINE_FOR_CLAIM batch titles and wording are exact", () => {
  const balances = Array.from({ length: 101 }, (_, i) => makeClaimableBalance(`T${i}:${ISSUER}`));
  const selections = Object.fromEntries(
    balances.map((b) => [b.id, "add_trustline_then_claim" as const])
  );
  const account = makeAccount({ claimableBalances: balances });
  const { steps } = buildPlan(account, false, false, selections);
  const batches = steps.filter((x) => x.type === "ADD_TRUSTLINE_FOR_CLAIM");
  expect(batches).toHaveLength(2);
  expect(batches[0]!.title).toBe("Add trustlines to claim (batch 1/2)");
  expect(batches[0]!.description).toBe(
    "Establish 100 trustlines so the following claimable balances can be claimed."
  );
  expect(batches[1]!.title).toBe("Add trustlines to claim (batch 2/2)");
  expect(batches[1]!.description).toBe(
    "Establish 1 trustline so the following claimable balance can be claimed."
  );
});

test("buildPlan › a single REMOVE_TRUSTLINES batch has no batch suffix, singular wording for one trustline", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "REMOVE_TRUSTLINES")!;
  expect(s.title).toBe("Remove trustlines");
  expect(s.description).toBe("Remove 1 trustline to recover the base reserve.");
});

test("buildPlan › 101 trustlines → REMOVE_TRUSTLINES batch titles and wording are exact", () => {
  const account = makeAccount({
    trustlines: Array.from({ length: 101 }, (_, i) => makeTrustline(`T${i}`, "0")),
  });
  const { steps } = buildPlan(account, false);
  const batches = steps.filter((x) => x.type === "REMOVE_TRUSTLINES");
  expect(batches[0]!.title).toBe("Remove trustlines (batch 1/2)");
  expect(batches[0]!.description).toBe("Remove 100 trustlines to recover the base reserve.");
  expect(batches[1]!.title).toBe("Remove trustlines (batch 2/2)");
  expect(batches[1]!.description).toBe("Remove 1 trustline to recover the base reserve.");
});

// ─── CLAIM_BALANCES detail string: xlmCount/tokenCount combinations ───────────

test("buildPlan › CLAIM_BALANCES detail is omitted when the batch is all-XLM", () => {
  const account = makeAccount({ claimableBalances: [makeClaimableBalance("native")] });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CLAIM_BALANCES")!;
  expect(s.title).toBe("Claim claimable balances");
  expect(s.description).toBe("Claim 1 claimable balance and add the proceeds to this account.");
});

test("buildPlan › CLAIM_BALANCES detail says '1 token' (singular) for exactly one non-XLM balance", () => {
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0")],
    claimableBalances: [makeClaimableBalance(`USDC:${ISSUER}`)],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CLAIM_BALANCES")!;
  expect(s.description).toBe(
    "Claim 1 claimable balance (1 token) and add the proceeds to this account."
  );
});

test("buildPlan › CLAIM_BALANCES detail says 'N tokens' (plural) for more than one non-XLM balance", () => {
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0"), makeTrustline("EURC", "0")],
    claimableBalances: [
      makeClaimableBalance(`USDC:${ISSUER}`),
      makeClaimableBalance(`EURC:${ISSUER}`),
    ],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CLAIM_BALANCES")!;
  expect(s.description).toBe(
    "Claim 2 claimable balances (2 tokens) and add the proceeds to this account."
  );
});

test("buildPlan › CLAIM_BALANCES detail combines XLM and token counts when both are present", () => {
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0")],
    claimableBalances: [makeClaimableBalance("native"), makeClaimableBalance(`USDC:${ISSUER}`)],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CLAIM_BALANCES")!;
  expect(s.description).toBe(
    "Claim 2 claimable balances (1 XLM, 1 token) and add the proceeds to this account."
  );
});

// ─── Fast-path gate: each of the six conditions isolated ──────────────────────

test("buildPlan › fast path requires hasCleanup - a clean account with nothing to fuse stays a plain MERGE", () => {
  const { steps } = buildPlan(makeAccount(), false, true);
  expect(steps).toHaveLength(1);
  expect(steps[0]!.type).toBe("MERGE");
});

test("buildPlan › fast path is refused when sponsoredEntries is non-empty even without a blocker", () => {
  const entry: SponsoredEntry = {
    kind: "trustline",
    owner: SPONSORED_OWNER,
    asset: `USDC:${ISSUER}`,
  };
  const account = makeAccount({
    numSponsoring: 1,
    sponsoredEntries: [entry],
    dataEntries: [{ key: "k", value: "" }],
  });
  const { steps } = buildPlan(
    account,
    false,
    true,
    {},
    { revocable: [entry], unaffordableOwners: new Map() }
  );
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
});

test("buildPlan › fast path fuses exactly at the 100-op boundary, refuses at 101", () => {
  const at100 = makeAccount({
    dataEntries: Array.from({ length: 99 }, (_, i) => ({ key: `k${i}`, value: "" })), // 99 + 1 merge = 100
  });
  const { steps: steps100 } = buildPlan(at100, false, true);
  expect(steps100.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(true);

  const at101 = makeAccount({
    dataEntries: Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, value: "" })), // 100 + 1 merge = 101
  });
  const { steps: steps101 } = buildPlan(at101, false, true);
  expect(steps101.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
});

test("buildPlan › CLOSE_ACCOUNT operationCount for a mediated close excludes the merge (forwarded separately)", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, true, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT")!;
  // 1 data entry only - the merge is its own separate MERGE step for a mediated close.
  expect(close.operationCount).toBe(1);
});

// ─── Convertible/needs-conversion filters: authorized and balance boundaries ──

test("buildPlan › an unauthorized trustline with a balance is not converted (fast-path fuse count excludes it)", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    trustlines: [makeTrustline("USDC", "10", false)],
  });
  const { steps } = buildPlan(account, false, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT");
  // hasCleanup is true (trustlines.length > 0), but the unauthorized trustline with a balance is
  // a deauthorized-with-balance blocker, so the fast path is refused entirely.
  expect(close).toBeUndefined();
});

test("buildPlan › a zero-balance trustline needs no HANDLE_ASSETS step even when authorized", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0", true)] });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "HANDLE_ASSETS")).toBe(false);
  expect(steps.some((s) => s.type === "REMOVE_TRUSTLINES")).toBe(true);
});

test("buildPlan › HANDLE_ASSETS title, description and affectedAsset are exact", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0")] });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe("Convert USDC to XLM");
  expect(s.description).toBe("Exchange 50.0 USDC for XLM via the Stellar DEX.");
  expect(s.operationCount).toBe(1);
});

// ─── computeNeedsSignerNormalization: each OR clause isolated ────────────────

test("buildPlan › a raised med threshold alone (high not raised) still triggers NORMALIZE_SIGNERS", () => {
  const account = makeAccount({ thresholds: { low: 0, med: 2, high: 1 } });
  const { steps } = buildPlan(account, false);
  expect(steps[0]!.type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › neither extra signers nor raised thresholds → no NORMALIZE_SIGNERS, no threshold blockers", () => {
  const account = makeAccount({ thresholds: { low: 0, med: 1, high: 1 } });
  const { steps, blockers } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "NORMALIZE_SIGNERS")).toBe(false);
  expect(blockers.some((b) => b.message.includes("weight 0"))).toBe(false);
  expect(blockers.some((b) => b.message.includes("can contribute at most"))).toBe(false);
});

// ─── extraSigners is "everyone but the master key", not "just the master key" ─

test("buildPlan › extraSigners counts every non-master signer, not just the master key itself", () => {
  const extra2 = Keypair.random().publicKey();
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
      { key: extra2, weight: 1, type: "ed25519_public_key" },
    ],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "NORMALIZE_SIGNERS")!;
  // 2 extra signers + 1 threshold reset = 3. A filter that kept only the master key
  // (s.key === masterKey instead of !==) would report length 1, giving operationCount 2.
  expect(s.operationCount).toBe(3);
  expect(s.description).toBe(
    "Remove 2 additional signer(s) and reset authorization thresholds so this key alone can authorize transactions."
  );
});

// ─── Exact text of every fixed (non-pluralized) blocker message ──────────────

test("buildPlan › AUTH_IMMUTABLE blocker message is exact", () => {
  const { blockers } = buildPlan(makeAccount({ authImmutable: true }), false);
  expect(blockers[0]!.message).toBe(
    "This account has the AUTH_IMMUTABLE flag set. ACCOUNT_MERGE is permanently disabled for " +
      "AUTH_IMMUTABLE accounts - the flag cannot be cleared once set."
  );
});

test("buildPlan › sponsored claimable-balance blocker message is exact", () => {
  const entry: SponsoredEntry = { kind: "claimable_balance", balanceId: "0".repeat(72) };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map(),
    }
  );
  const b = blockers.find((x) => x.code === "sponsorship_claimable_balance_unrevocable")!;
  expect(b.message).toBe(
    "This account sponsors a claimable balance, which cannot be revoked without a cooperating " +
      "new sponsor. It resolves automatically once a claimant claims the balance - there is no " +
      "self-service action to take here."
  );
});

test("buildPlan › pool-share blocker message is exact", () => {
  const account = makeAccount({ poolShares: [{ poolId: "p1" }] });
  const { blockers } = buildPlan(account, false);
  expect(blockers[0]!.message).toBe(
    "This account holds 1 liquidity pool share(s). Withdraw from the pool using a DEX interface " +
      "(e.g. Stellar Expert) before continuing."
  );
});

test("buildPlan › sub-entry mismatch blocker message is exact", () => {
  const { blockers } = buildPlan(makeAccount({ subEntryMismatch: true }), false);
  expect(blockers[0]!.message).toBe(
    "This account has entries that could not be enumerated. The analysis may be incomplete - " +
      "do not proceed until the discrepancy is resolved."
  );
});

test("buildPlan › deauthorized-trustline-with-balance blocker message is exact", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "5", false)] });
  const { blockers } = buildPlan(account, false);
  const b = blockers[0]!;
  expect(b.message).toBe(
    "Trustline for USDC has a non-zero balance (5) but is deauthorized by the issuer. The " +
      "issuer must re-authorize this trustline before it can be converted or removed."
  );
});

test("buildPlan › unclaimable-balance blocker message is exact", () => {
  const cb = makeClaimableBalance(`USDC:${ISSUER}`, "3.0000000");
  const account = makeAccount({ claimableBalances: [cb] });
  const { blockers } = buildPlan(account, false);
  const b = blockers.find((x) => x.code === "claimable_balance_unclaimable")!;
  expect(b.message).toBe(
    "This account is a claimant for 3.0000000 USDC but has no authorized trustline for it. " +
      "Establish a USDC trustline and claim the balance manually before proceeding - these " +
      "funds will be permanently inaccessible once the account is merged."
  );
});

test("buildPlan › master-key-weight-0 blocker message is exact", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 0, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
  });
  const { blockers } = buildPlan(account, false);
  const b = blockers.find((x) => x.message.includes("weight 0"))!;
  expect(b.message).toBe(
    "The master key on this account has weight 0. Removing the account's other signers would " +
      "leave no key able to authorize any further changes to this account, so this flow cannot " +
      "safely proceed."
  );
});

test("buildPlan › unsatisfiable-signer blocker message is exact (the full sentence, both halves)", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 5, type: "ed25519_signed_payload" },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  const b = blockers.find((x) => x.message.includes("can contribute at most"))!;
  expect(b.message).toBe(
    "This account's signers can contribute at most weight 1 toward removing signers or " +
      "changing thresholds, but that requires weight 2 (the current high threshold). At least " +
      "one of its signers cannot be authorized through this flow, so this change can never be " +
      "fully authorized."
  );
});

// ─── satisfiableWeight: hash_x and preauth_tx each count on their own ─────────

test("buildPlan › a hash_x signer's weight alone can satisfy the high threshold", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: "XHASH0000000000000000000000000000000000000000000000000000",
        weight: 1,
        type: "hash_x",
      },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("can contribute at most"))).toBe(false);
});

test("buildPlan › a preauth_tx signer's weight alone can satisfy the high threshold", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: "TPREAUTH0000000000000000000000000000000000000000000000000",
        weight: 1,
        type: "preauth_tx",
      },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const { blockers } = buildPlan(account, false);
  expect(blockers.some((b) => b.message.includes("can contribute at most"))).toBe(false);
});

// ─── describeSponsoredEntry: the claimable_balance case, via the unaffordable-owner path ─

test("buildPlan › describes a claimable_balance sponsored entry (even though buildPlan itself never routes one here)", () => {
  const owner = Keypair.random().publicKey();
  const entry: SponsoredEntry = { kind: "claimable_balance", balanceId: "0".repeat(72) };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [{ kind: "account", owner }] });
  const { blockers } = buildPlan(
    account,
    false,
    false,
    {},
    {
      revocable: [],
      unaffordableOwners: new Map([[owner, { entries: [entry], shortfallXlm: "1.0000000" }]]),
    }
  );
  const b = blockers.find((x) => x.code === "sponsorship_unaffordable")!;
  expect(b.message).toContain("a claimable balance");
});

// ─── convertible/fast-path fuse count: balance and authorization boundaries ──

test("buildPlan › fast path: a trustline with balance exactly 0 is not counted toward the fuse (still just cleanup)", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    trustlines: [makeTrustline("USDC", "0", true)],
  });
  const { steps } = buildPlan(account, false, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT")!;
  // 1 data entry + 0 conversion ops + 1 trustline removal + 1 merge = 3 (not 4, which an
  // off-by-one on the balance boundary would give).
  expect(close.operationCount).toBe(3);
});

// ─── hasCleanup: openOffers alone is sufficient to trigger the fast path ──────

test("buildPlan › fast path triggers on open offers alone, with nothing else to clean up", () => {
  const account = makeAccount({
    openOffers: [{ id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" }],
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(true);
});

// ─── hasHardBlocker: a forfeited-balance blocker alone never excludes the fast path ───

test("buildPlan › fast path proceeds when the only blocker is an acknowledged forfeiture", () => {
  const cb = makeClaimableBalance(`USDC:${ISSUER}`);
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }], claimableBalances: [cb] });
  const { steps } = buildPlan(account, false, true, { [cb.id]: "forfeit" });
  // balancesNeedingClaimStep is empty (forfeited), so the fast path is otherwise eligible; the
  // forfeiture blocker alone must not block it.
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(true);
});

test("buildPlan › fast path is excluded by any blocker other than an acknowledged forfeiture", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k", value: "" }],
    trustlines: [makeTrustline("USDC", "5", false)], // deauthorized-with-balance: a real blocker
  });
  const { steps } = buildPlan(account, false, true);
  expect(steps.some((s) => s.type === "CLOSE_ACCOUNT")).toBe(false);
});

// ─── Fast-path CLOSE_ACCOUNT: exact title/description, both mediatorRequired branches ─

test("buildPlan › fast-path CLOSE_ACCOUNT title/description, direct destination", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, false, true);
  const s = steps.find((x) => x.type === "CLOSE_ACCOUNT")!;
  expect(s.title).toBe("Close account");
  expect(s.description).toBe(
    "Remove signers, data, offers, and trustlines, convert balances to XLM, and merge the " +
      "account, all in one transaction."
  );
});

test("buildPlan › fast-path CLOSE_ACCOUNT title/description, mediator (exchange) destination", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, true, true);
  const s = steps.find((x) => x.type === "CLOSE_ACCOUNT")!;
  expect(s.title).toBe("Clean up account");
  expect(s.description).toBe(
    "Remove signers, data, offers, and trustlines, and convert balances to XLM, in one " +
      "transaction. The merge to your exchange address follows as a co-signed transfer."
  );
});

test("buildPlan › fast-path's own MERGE step (the co-signed forward) has its own exact title/description, distinct from CLOSE_ACCOUNT and the non-fast-path MERGE", () => {
  const account = makeAccount({ dataEntries: [{ key: "k", value: "" }] });
  const { steps } = buildPlan(account, true, true);
  const s = steps.find((x) => x.type === "MERGE")!;
  expect(s.title).toBe("Merge and forward to exchange");
  expect(s.description).toBe(
    "Close this account and forward the full balance to your exchange deposit address in one " +
      "atomic transaction, routed through a shared intermediary."
  );
  expect(s.operationCount).toBe(2);
});

test("buildPlan › fast-path CLOSE_ACCOUNT operationCount for extra signers uses +1 (removal + threshold reset), not -1", () => {
  const account = makeAccount({
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
  });
  const { steps } = buildPlan(account, false, true);
  const close = steps.find((s) => s.type === "CLOSE_ACCOUNT")!;
  // signerOps = 1 extra signer removal + 1 threshold reset = 2; plus the merge = 3.
  expect(close.operationCount).toBe(3);
});

// ─── Final MERGE step: exact description, both mediatorRequired branches ─────

test("buildPlan › final MERGE step description, direct destination", () => {
  const { steps } = buildPlan(makeAccount(), false);
  const s = steps.find((x) => x.type === "MERGE")!;
  expect(s.description).toBe(
    "Merge this account, transferring the XLM balance to the destination account and removing " +
      "it from the Stellar ledger."
  );
});

test("buildPlan › final MERGE step description, mediator (exchange) destination", () => {
  const { steps } = buildPlan(makeAccount(), true);
  const s = steps.find((x) => x.type === "MERGE")!;
  expect(s.description).toBe(
    "Close this account and forward the full balance to your exchange deposit address in one " +
      "atomic transaction, routed through a shared intermediary. You recover essentially all of " +
      "your XLM; only standard network fees apply."
  );
});

// ─── CLAIM_BALANCES: mixed XLM+token detail pluralizes the token count on its own ─

test("buildPlan › CLAIM_BALANCES detail pluralizes 'tokens' inside the mixed XLM+token branch", () => {
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0"), makeTrustline("EURC", "0")],
    claimableBalances: [
      makeClaimableBalance("native"),
      makeClaimableBalance(`USDC:${ISSUER}`),
      makeClaimableBalance(`EURC:${ISSUER}`),
    ],
  });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "CLAIM_BALANCES")!;
  expect(s.description).toBe(
    "Claim 3 claimable balances (1 XLM, 2 tokens) and add the proceeds to this account."
  );
});

// ─── CLAIM_BALANCES batching: the 101-item boundary, exact titles ────────────

test("buildPlan › 101 claimable balances → 2 CLAIM_BALANCES batches, titled exactly", () => {
  const balances = Array.from({ length: 101 }, (_, i) =>
    makeClaimableBalance("native", `${i + 1}.0000000`)
  );
  // makeClaimableBalance derives the id from the asset, which is identical ("native") for every
  // entry here - give each a distinct id directly so all 101 survive as distinct balances.
  const distinct = balances.map((b, i) => ({ ...b, id: `${i}`.padStart(8, "0").padEnd(72, "0") }));
  const account = makeAccount({ claimableBalances: distinct });
  const { steps } = buildPlan(account, false);
  const batches = steps.filter((x) => x.type === "CLAIM_BALANCES");
  expect(batches).toHaveLength(2);
  expect(batches[0]!.title).toBe("Claim balances (batch 1/2)");
  expect(batches[1]!.title).toBe("Claim balances (batch 2/2)");
  expect(batches[1]!.description).toBe(
    "Claim 1 claimable balance and add the proceeds to this account."
  );
});

// ─── Per-asset dispositions drive the step labels ────────────────────────────
//
// Regression for the review page announcing "Convert X to XLM" for every asset with a balance,
// whatever the user actually chose. The plan is the app's informed-consent surface - the last
// screen before an irreversible close is signed - so a step that says "convert" while the
// transaction returns the balance to its issuer, or pays it to a third account, is telling the
// user something untrue at the moment they approve it. buildPlan never received the
// dispositions at all, so it could not have labelled them correctly.

test("buildPlan › issuer disposition → step says return to issuer, not convert", () => {
  const asset = `BURN:${ISSUER}`;
  const account = makeAccount({ trustlines: [makeTrustline("BURN", "25.0000000")] });
  const { steps } = buildPlan(account, false, false, {}, undefined, { [asset]: "issuer" });
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe("Return BURN to issuer");
  expect(s.description).toBe("Send 25.0000000 BURN back to its issuer. You give up these tokens.");
});

test("buildPlan › transfer disposition → step names the destination it pays", () => {
  const asset = `KEEP:${ISSUER}`;
  const dest = Keypair.random().publicKey();
  const account = makeAccount({ trustlines: [makeTrustline("KEEP", "40.0000000")] });
  const { steps } = buildPlan(
    account,
    false,
    false,
    {},
    undefined,
    { [asset]: "transfer" },
    {
      [asset]: dest,
    }
  );
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe(`Send KEEP to ${dest.slice(0, 8)}…${dest.slice(-8)}`);
  expect(s.description).toBe(
    `Send 40.0000000 KEEP to ${dest.slice(0, 8)}…${dest.slice(-8)}, which already holds the trustline.`
  );
});

test("buildPlan › transfer chosen but no destination resolved yet → no invented address", () => {
  // The controller pushes such an asset back onto the pending list, so this state is only ever
  // seen mid-decision. It must still not claim a conversion, and must not render "undefined".
  const asset = `KEEP:${ISSUER}`;
  const account = makeAccount({ trustlines: [makeTrustline("KEEP", "40.0000000")] });
  const { steps } = buildPlan(account, false, false, {}, undefined, { [asset]: "transfer" });
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe("Send KEEP to another account");
  expect(s.description).toBe(
    "Send 40.0000000 KEEP to another account that already holds the trustline."
  );
});

test("buildPlan › explicit convert disposition keeps the conversion wording", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "5.0000000")] });
  const { steps } = buildPlan(account, false, false, {}, undefined, { [asset]: "convert" });
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe("Convert USDC to XLM");
  expect(s.description).toBe("Exchange 5.0000000 USDC for XLM via the Stellar DEX.");
});

test("buildPlan › no disposition given → unchanged convert wording", () => {
  // Back-compat: every caller that predates dispositions, and every asset the user has not
  // decided on yet, keeps the conversion default the app already offers.
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "5.0000000")] });
  const { steps } = buildPlan(account, false);
  const s = steps.find((x) => x.type === "HANDLE_ASSETS")!;
  expect(s.title).toBe("Convert USDC to XLM");
});

test("buildPlan › three assets, three dispositions → three distinct labels", () => {
  // The whole point of the per-asset deliverable: one close, three different outcomes. A single
  // asset test cannot catch a label derived from the wrong asset's disposition.
  const dest = Keypair.random().publicKey();
  const account = makeAccount({
    trustlines: [
      makeTrustline("USDC", "5.0000000"),
      makeTrustline("KEEP", "40.0000000"),
      makeTrustline("BURN", "25.0000000"),
    ],
  });
  const { steps } = buildPlan(
    account,
    false,
    false,
    {},
    undefined,
    {
      [`USDC:${ISSUER}`]: "convert",
      [`KEEP:${ISSUER}`]: "transfer",
      [`BURN:${ISSUER}`]: "issuer",
    },
    { [`KEEP:${ISSUER}`]: dest }
  );
  const titles = steps.filter((s) => s.type === "HANDLE_ASSETS").map((s) => s.title);
  expect(titles).toEqual([
    "Convert USDC to XLM",
    `Send KEEP to ${dest.slice(0, 8)}…${dest.slice(-8)}`,
    "Return BURN to issuer",
  ]);
});

// ─── A balance claimed through a new trustline is part of the plan ──────────
//
// The plan used to read "add trustline -> claim -> merge" for this shape: no handling of what
// the claim brings in, and no removal of the trustline the plan itself just added. That is not
// a close that could succeed - a merge fails while a trustline exists - so the review page was
// describing something the network would reject, and the execution dead-ended a round later.

function claimableWithId(id: string, asset: string, amount = "5.0000000"): ClaimableBalance {
  return {
    id,
    asset,
    amount,
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

test("buildPlan › a balance claimed via a new trustline gets a HANDLE_ASSETS step", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({ claimableBalances: [claimableWithId("cb1", asset)] });

  const { steps } = buildPlan(account, false, false, { cb1: "add_trustline_then_claim" });

  const handled = steps.filter((s) => s.type === "HANDLE_ASSETS");
  expect(handled).toHaveLength(1);
  expect(handled[0]!.affectedAsset).toBe(asset);
});

test("buildPlan › the trustline the plan adds is also removed by the plan", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({ claimableBalances: [claimableWithId("cb1", asset)] });

  const { steps } = buildPlan(account, false, false, { cb1: "add_trustline_then_claim" });

  const removal = steps.find((s) => s.type === "REMOVE_TRUSTLINES");
  expect(removal).toBeDefined();
  expect(removal!.operationCount).toBe(1);
});

test("buildPlan › claim runs before the asset it delivers is handled", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({ claimableBalances: [claimableWithId("cb1", asset)] });

  const { steps } = buildPlan(account, false, false, { cb1: "add_trustline_then_claim" });
  const order = (t: string) => steps.findIndex((s) => s.type === t);

  expect(order("ADD_TRUSTLINE_FOR_CLAIM")).toBeLessThan(order("CLAIM_BALANCES"));
  expect(order("CLAIM_BALANCES")).toBeLessThan(order("HANDLE_ASSETS"));
  expect(order("HANDLE_ASSETS")).toBeLessThan(order("REMOVE_TRUSTLINES"));
});

test("buildPlan › a forfeited balance brings nothing in, so nothing is handled", () => {
  const account = makeAccount({
    claimableBalances: [claimableWithId("cb1", `USDC:${ISSUER}`)],
  });

  const { steps } = buildPlan(account, false, false, { cb1: "forfeit" });

  expect(steps.some((s) => s.type === "HANDLE_ASSETS")).toBe(false);
});

test("buildPlan › three balances, three outcomes, in one plan", () => {
  // The shape the recording exercises: one asset already trusted, one arriving through a new
  // trustline, one given up. Only the first two produce work.
  const trusted = `EURC:${ISSUER}`;
  const arriving = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("EURC", "0")],
    claimableBalances: [
      claimableWithId("cb-trusted", trusted, "4.0000000"),
      claimableWithId("cb-arriving", arriving, "5.0000000"),
      claimableWithId("cb-given-up", `JUNK:${ISSUER}`, "9.0000000"),
    ],
  });

  const { steps } = buildPlan(account, false, false, {
    "cb-trusted": "claim",
    "cb-arriving": "add_trustline_then_claim",
    "cb-given-up": "forfeit",
  });

  const handled = steps.filter((s) => s.type === "HANDLE_ASSETS").map((s) => s.affectedAsset);
  expect(handled).toContain(trusted);
  expect(handled).toContain(arriving);
  expect(handled).not.toContain(`JUNK:${ISSUER}`);
});
