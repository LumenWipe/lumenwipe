import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { buildPlan } from "@/lib/stellar/tx-builder";
import type { AccountState } from "@/types/account";

const MASTER_KP = Keypair.random();
const EXTRA_KP = Keypair.random();
const MASTER = MASTER_KP.publicKey();
const EXTRA = EXTRA_KP.publicKey();

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
    sponsoredBy: null,
    trustlines: [],
    openOffers: [],
    ...overrides,
  };
}

test("buildPlan › clean account → single MERGE step", () => {
  const plan = buildPlan(makeAccount(), false);
  expect(plan).toHaveLength(1);
  expect(plan[0].type).toBe("MERGE");
});

test("buildPlan › mediatorRequired=true → single MERGE step (shared mediator)", () => {
  const plan = buildPlan(makeAccount(), true);
  expect(plan).toHaveLength(1);
  expect(plan[0].type).toBe("MERGE");
});

test("buildPlan › MERGE step title reflects the exchange route when mediator required", () => {
  const plan = buildPlan(makeAccount(), true);
  const mergeStep = plan.find((s) => s.type === "MERGE")!;
  expect(mergeStep.title.toLowerCase()).toContain("exchange");
});

test("buildPlan › MERGE step direct title when no mediator", () => {
  const plan = buildPlan(makeAccount(), false);
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
  const plan = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › raised med threshold alone triggers NORMALIZE_SIGNERS", () => {
  const account = makeAccount({
    thresholds: { low: 0, med: 2, high: 2 },
  });
  const plan = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › raised high threshold alone triggers NORMALIZE_SIGNERS", () => {
  const account = makeAccount({
    thresholds: { low: 0, med: 1, high: 2 },
  });
  const plan = buildPlan(account, false);
  expect(plan[0].type).toBe("NORMALIZE_SIGNERS");
});

test("buildPlan › data entries → REMOVE_DATA_ENTRIES step", () => {
  const account = makeAccount({
    dataEntries: [
      { key: "key1", value: "dmFsdWU=" },
      { key: "key2", value: "dmFsdWU=" },
    ],
  });
  const plan = buildPlan(account, false);
  const step = plan.find((s) => s.type === "REMOVE_DATA_ENTRIES");
  expect(step).toBeDefined();
  expect(step!.operationCount).toBe(2);
});

test("buildPlan › 101 data entries → 2 REMOVE_DATA_ENTRIES batches", () => {
  const account = makeAccount({
    dataEntries: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, value: "" })),
  });
  const plan = buildPlan(account, false);
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
  const plan = buildPlan(account, false);
  const step = plan.find((s) => s.type === "CANCEL_OFFERS");
  expect(step).toBeDefined();
  expect(step!.operationCount).toBe(2);
});

test("buildPlan › trustline with balance → CONVERT_ASSETS before REMOVE_TRUSTLINES", () => {
  const account = makeAccount({
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "100.0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
  const convertIdx = plan.findIndex((s) => s.type === "CONVERT_ASSETS");
  const removeIdx = plan.findIndex((s) => s.type === "REMOVE_TRUSTLINES");
  expect(convertIdx).toBeGreaterThanOrEqual(0);
  expect(removeIdx).toBeGreaterThanOrEqual(0);
  expect(convertIdx).toBeLessThan(removeIdx);
});

test("buildPlan › CONVERT_ASSETS step includes affectedAsset", () => {
  const account = makeAccount({
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "50.0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
  const step = plan.find((s) => s.type === "CONVERT_ASSETS");
  expect(step!.affectedAsset).toBe("USDC:GABC123");
});

test("buildPlan › trustline with zero balance → no CONVERT_ASSETS", () => {
  const account = makeAccount({
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
  const convertStep = plan.find((s) => s.type === "CONVERT_ASSETS");
  expect(convertStep).toBeUndefined();
});

test("buildPlan › trustline with zero balance → still has REMOVE_TRUSTLINES", () => {
  const account = makeAccount({
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
  const removeStep = plan.find((s) => s.type === "REMOVE_TRUSTLINES");
  expect(removeStep).toBeDefined();
});

test("buildPlan › step indices are sequential from 0", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k1", value: "" }],
    openOffers: [{ id: "1", selling: "native", buying: "USDC:G", amount: "1", price: "1" }],
  });
  const plan = buildPlan(account, false);
  plan.forEach((step, i) => {
    expect(step.index).toBe(i);
  });
});

test("buildPlan › all steps start with status 'pending'", () => {
  const account = makeAccount({
    dataEntries: [{ key: "k1", value: "" }],
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
  expect(plan.every((s) => s.status === "pending")).toBe(true);
});

test("buildPlan › all steps have non-null estimatedFeeLumens", () => {
  const plan = buildPlan(makeAccount(), false);
  expect(plan.every((s) => s.estimatedFeeLumens !== null)).toBe(true);
  expect(plan.every((s) => parseFloat(s.estimatedFeeLumens) > 0)).toBe(true);
});

test("buildPlan › all steps have txXdr=null initially", () => {
  const plan = buildPlan(makeAccount(), false);
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
    trustlines: [
      {
        asset: "USDC:GABC123",
        balance: "50.0",
        limit: "1000",
        authorized: true,
        issuer: "GABC123",
        code: "USDC",
      },
    ],
  });
  const plan = buildPlan(account, false);
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
    trustlines: Array.from({ length: 5 }, (_, i) => ({
      asset: `TK${i}:GABC${i}`,
      balance: "10.0",
      limit: "1000",
      authorized: true,
      issuer: `GABC${i}`,
      code: `TK${i}`,
    })),
  });
  const plan = buildPlan(account, false);
  const convertSteps = plan.filter((s) => s.type === "CONVERT_ASSETS");
  const removeSteps = plan.filter((s) => s.type === "REMOVE_TRUSTLINES");
  expect(convertSteps).toHaveLength(5);
  expect(removeSteps).toHaveLength(1);
});
