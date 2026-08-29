import { test, expect } from "bun:test";
import { buildTxLedger, labelForTx } from "@/lib/utils/txLedger";
import type { PlannedStep, StepType } from "@/types/plan";

function confirmedStep(
  index: number,
  type: StepType,
  title: string,
  txHash: string | null
): PlannedStep {
  return {
    index,
    type,
    title,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.00001",
    txXdr: null,
    status: "confirmed",
    txHash,
    error: null,
  };
}

test("buildTxLedger › fused fast-path is one transaction", () => {
  const steps = [confirmedStep(0, "CLOSE_ACCOUNT", "Close account", "HASH_A")];

  const ledger = buildTxLedger(steps);

  expect(ledger).toEqual([
    { txHash: "HASH_A", stepTypes: ["CLOSE_ACCOUNT"], stepTitles: ["Close account"] },
  ]);
});

test("buildTxLedger › mediator merge is two transactions in order", () => {
  const steps = [
    confirmedStep(0, "CLOSE_ACCOUNT", "Clean up account", "HASH_A"),
    confirmedStep(1, "MERGE", "Merge and forward to exchange", "HASH_B"),
  ];

  const ledger = buildTxLedger(steps);

  expect(ledger).toEqual([
    { txHash: "HASH_A", stepTypes: ["CLOSE_ACCOUNT"], stepTitles: ["Clean up account"] },
    { txHash: "HASH_B", stepTypes: ["MERGE"], stepTitles: ["Merge and forward to exchange"] },
  ]);
});

test("buildTxLedger › stepwise run yields one entry per distinct hash, in order", () => {
  const steps = [
    confirmedStep(0, "NORMALIZE_SIGNERS", "Remove extra signers", "H1"),
    confirmedStep(1, "REMOVE_DATA_ENTRIES", "Remove data entries", "H2"),
    confirmedStep(2, "REMOVE_TRUSTLINES", "Remove trustlines", "H3"),
    confirmedStep(3, "MERGE", "Merge account", "H4"),
  ];

  const ledger = buildTxLedger(steps);

  expect(ledger.map((e) => e.txHash)).toEqual(["H1", "H2", "H3", "H4"]);
  expect(ledger).toHaveLength(4);
});

test("buildTxLedger › steps sharing a hash collapse into one entry", () => {
  // Defensive: should several steps ever land in the same transaction, they group.
  const steps = [
    confirmedStep(0, "NORMALIZE_SIGNERS", "Remove extra signers", "SAME"),
    confirmedStep(1, "REMOVE_DATA_ENTRIES", "Remove data entries", "SAME"),
  ];

  const ledger = buildTxLedger(steps);

  expect(ledger).toEqual([
    {
      txHash: "SAME",
      stepTypes: ["NORMALIZE_SIGNERS", "REMOVE_DATA_ENTRIES"],
      stepTitles: ["Remove extra signers", "Remove data entries"],
    },
  ]);
});

test("buildTxLedger › steps without a hash are skipped", () => {
  const steps = [
    confirmedStep(0, "NORMALIZE_SIGNERS", "Remove extra signers", null),
    confirmedStep(1, "MERGE", "Merge account", "H1"),
  ];

  const ledger = buildTxLedger(steps);

  expect(ledger).toEqual([{ txHash: "H1", stepTypes: ["MERGE"], stepTitles: ["Merge account"] }]);
});

test("buildTxLedger › empty input yields an empty ledger", () => {
  expect(buildTxLedger([])).toEqual([]);
});

// ─── labelForTx: the ledger row's one-line summary ──────────────────────────
//
// The row used to join every step's full title with " + ", which the per-asset
// dispositions made unreadable: "Return BURN to issuer + Send KEEP to GAWIWBZJ…TSY2VKTZ +
// Convert US…" - CSS-truncated mid-word, and a recap of the "what was done" groups sitting
// directly above it. The row's job is to identify a transaction, not to restate it.

test("labelForTx › names the phases, not every step title", () => {
  const ledger = buildTxLedger([
    confirmedStep(0, "HANDLE_ASSETS", "Return BURN to issuer", "H1"),
    confirmedStep(1, "HANDLE_ASSETS", "Send KEEP to GAWIWBZJ…TSY2VKTZ", "H1"),
    confirmedStep(2, "HANDLE_ASSETS", "Convert USDC to XLM", "H1"),
    confirmedStep(3, "REMOVE_TRUSTLINES", "Remove trustlines", "H1"),
    confirmedStep(4, "MERGE", "Merge account", "H1"),
  ]);

  expect(labelForTx(ledger[0]!)).toBe("Handle assets · Remove trustlines · Merge account");
});

test("labelForTx › a type split across batches appears once", () => {
  // Two REVOKE_SPONSORSHIP batches in one transaction repeated the label under the old
  // join; the phase is one thing regardless of how many transactions' worth of operations
  // it took.
  const ledger = buildTxLedger([
    confirmedStep(0, "REVOKE_SPONSORSHIP", "Revoke sponsorships (batch 1/2)", "H1"),
    confirmedStep(1, "REVOKE_SPONSORSHIP", "Revoke sponsorships (batch 2/2)", "H1"),
    confirmedStep(2, "MERGE", "Merge account", "H1"),
  ]);

  expect(labelForTx(ledger[0]!)).toBe("Revoke sponsorships · Merge account");
});

test("labelForTx › keeps first-occurrence order, not alphabetical", () => {
  const ledger = buildTxLedger([
    confirmedStep(0, "MERGE", "Merge account", "H1"),
    confirmedStep(1, "CANCEL_OFFERS", "Cancel offers", "H1"),
  ]);

  expect(labelForTx(ledger[0]!)).toBe("Merge account · Cancel offers");
});

test("labelForTx › the fused close is a single phase", () => {
  const ledger = buildTxLedger([confirmedStep(0, "CLOSE_ACCOUNT", "Close account", "H1")]);

  expect(labelForTx(ledger[0]!)).toBe("Close account");
});
