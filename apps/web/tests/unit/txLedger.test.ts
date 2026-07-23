import { test, expect } from "bun:test";
import { buildTxLedger } from "@/lib/utils/txLedger";
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
