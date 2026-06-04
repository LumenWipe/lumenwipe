import type { AccountState } from "@/types/account";
import type { PlannedStep, StepType } from "@/types/plan";
import { estimateFeeLumens } from "@/lib/utils/amounts";
import { batchItems } from "./batching";
import { OP_BATCH_LIMIT } from "@/config/constants";

function step(
  index: number,
  type: StepType,
  title: string,
  description: string,
  operationCount: number,
  extra?: Partial<PlannedStep>
): PlannedStep {
  return {
    index,
    type,
    title,
    description,
    operationCount,
    estimatedFeeLumens: estimateFeeLumens(operationCount),
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
    ...extra,
  };
}

export function buildPlan(accountState: AccountState, mediatorRequired: boolean): PlannedStep[] {
  const steps: PlannedStep[] = [];
  let idx = 0;

  const { signers, thresholds, dataEntries, openOffers, trustlines } = accountState;
  const masterKey = accountState.address;
  const extraSigners = signers.filter((s) => s.key !== masterKey);

  const needsSignerNormalization =
    extraSigners.length > 0 || thresholds.med > 1 || thresholds.high > 1;

  if (needsSignerNormalization) {
    steps.push(
      step(
        idx++,
        "NORMALIZE_SIGNERS",
        "Remove extra signers",
        `Remove ${extraSigners.length} additional signer(s) and reset authorization thresholds so this key alone can authorize transactions.`,
        extraSigners.length + 1
      )
    );
  }

  if (dataEntries.length > 0) {
    const batches = batchItems(dataEntries, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "REMOVE_DATA_ENTRIES",
          batches.length > 1
            ? `Remove data entries (batch ${i + 1}/${batches.length})`
            : "Remove data entries",
          `Clear ${batch.length} data entr${batch.length === 1 ? "y" : "ies"} stored on this account.`,
          batch.length
        )
      );
    }
  }

  if (openOffers.length > 0) {
    const batches = batchItems(openOffers, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "CANCEL_OFFERS",
          batches.length > 1
            ? `Cancel DEX offers (batch ${i + 1}/${batches.length})`
            : "Cancel open DEX offers",
          `Cancel ${batch.length} open offer${batch.length === 1 ? "" : "s"} on the Stellar DEX.`,
          batch.length
        )
      );
    }
  }

  const trustlinesWithBalance = trustlines.filter((tl) => parseFloat(tl.balance) > 0);
  for (const tl of trustlinesWithBalance) {
    steps.push(
      step(
        idx++,
        "CONVERT_ASSETS",
        `Convert ${tl.code} to XLM`,
        `Exchange ${tl.balance} ${tl.code} for XLM via the Stellar DEX.`,
        1,
        { affectedAsset: tl.asset }
      )
    );
  }

  if (trustlines.length > 0) {
    const batches = batchItems(trustlines, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "REMOVE_TRUSTLINES",
          batches.length > 1
            ? `Remove trustlines (batch ${i + 1}/${batches.length})`
            : "Remove trustlines",
          `Remove ${batch.length} trustline${batch.length === 1 ? "" : "s"} to recover the base reserve.`,
          batch.length
        )
      );
    }
  }

  steps.push(
    step(
      idx++,
      "MERGE",
      mediatorRequired ? "Merge and forward to exchange" : "Merge account",
      mediatorRequired
        ? "Close this account and forward the full balance to your exchange deposit address in one atomic transaction, routed through a shared intermediary. You recover essentially all of your XLM; only standard network fees apply."
        : "Merge this account, transferring the XLM balance to the destination account and removing it from the Stellar ledger.",
      mediatorRequired ? 2 : 1
    )
  );

  return steps;
}
