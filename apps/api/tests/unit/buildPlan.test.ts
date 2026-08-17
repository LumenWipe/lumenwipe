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

test("buildPlan › trustline with balance → CONVERT_ASSETS before REMOVE_TRUSTLINES", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "100.0")] });
  const { steps: plan } = buildPlan(account, false);
  const convertIdx = plan.findIndex((s) => s.type === "CONVERT_ASSETS");
  const removeIdx = plan.findIndex((s) => s.type === "REMOVE_TRUSTLINES");
  expect(convertIdx).toBeGreaterThanOrEqual(0);
  expect(removeIdx).toBeGreaterThanOrEqual(0);
  expect(convertIdx).toBeLessThan(removeIdx);
});

test("buildPlan › CONVERT_ASSETS step includes affectedAsset", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0")] });
  const { steps: plan } = buildPlan(account, false);
  const step = plan.find((s) => s.type === "CONVERT_ASSETS");
  expect(step!.affectedAsset).toBe(`USDC:${ISSUER}`);
});

test("buildPlan › trustline with zero balance → no CONVERT_ASSETS", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.find((s) => s.type === "CONVERT_ASSETS")).toBeUndefined();
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
  expect(types).toContain("CONVERT_ASSETS");
  expect(types).toContain("REMOVE_TRUSTLINES");
  expect(types).toContain("MERGE");
});

test("buildPlan › 5 trustlines with balance → 5 CONVERT_ASSETS steps + 1 REMOVE_TRUSTLINES", () => {
  const account = makeAccount({
    trustlines: Array.from({ length: 5 }, (_, i) => makeTrustline(`TK${i}`, "10.0")),
  });
  const { steps: plan } = buildPlan(account, false);
  expect(plan.filter((s) => s.type === "CONVERT_ASSETS")).toHaveLength(5);
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

test("buildPlan › deauthorized trustline with balance → no CONVERT_ASSETS for that asset", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0", false)] });
  const { steps } = buildPlan(account, false);
  // A deauthorized trustline cannot be converted - no CONVERT_ASSETS should be emitted for it.
  expect(steps.find((s) => s.type === "CONVERT_ASSETS")).toBeUndefined();
});

test("buildPlan › deauthorized trustline with balance → REMOVE_TRUSTLINES still present", () => {
  // The plan includes REMOVE_TRUSTLINES so the user can see what needs clearing once
  // the issuer re-authorizes; the blocker prevents actual execution.
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "50.0", false)] });
  const { steps } = buildPlan(account, false);
  expect(steps.find((s) => s.type === "REMOVE_TRUSTLINES")).toBeDefined();
});

test("buildPlan › authorized and deauthorized trustlines mixed → only authorized gets CONVERT_ASSETS", () => {
  const account = makeAccount({
    trustlines: [
      makeTrustline("USDC", "100.0", true), // authorized with balance
      makeTrustline("BTC", "1.0", false), // deauthorized with balance - blocked
    ],
  });
  const { steps, blockers } = buildPlan(account, false);
  const convertSteps = steps.filter((s) => s.type === "CONVERT_ASSETS");
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

test("buildPlan › CLAIM_BALANCES comes after CANCEL_OFFERS and before CONVERT_ASSETS", () => {
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

test("buildPlan › zero-balance trustline with claimable balance for same asset → CONVERT_ASSETS included", () => {
  // After claiming, the trustline will have balance. CONVERT_ASSETS must be in the plan
  // so REMOVE_TRUSTLINES doesn't fail with change_trust_cannot_delete.
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)], // zero balance now
    claimableBalances: [makeClaimableBalance(asset, "50.0")], // will add 50 USDC after claiming
  });
  const { steps } = buildPlan(account, false);
  expect(steps.some((s) => s.type === "CLAIM_BALANCES")).toBe(true);
  expect(steps.some((s) => s.type === "CONVERT_ASSETS" && s.affectedAsset === asset)).toBe(true);
});

test("buildPlan › CLAIM_BALANCES comes before CONVERT_ASSETS for same asset", () => {
  const asset = `USDC:${ISSUER}`;
  const account = makeAccount({
    trustlines: [makeTrustline("USDC", "0", true)],
    claimableBalances: [makeClaimableBalance(asset, "50.0")],
  });
  const { steps } = buildPlan(account, false);
  const claimIdx = steps.findIndex((s) => s.type === "CLAIM_BALANCES");
  const convertIdx = steps.findIndex((s) => s.type === "CONVERT_ASSETS");
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
