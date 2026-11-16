import type { PlanEstimate, PlannedStep } from "@lumenwipe/types";
import { isTokenContract } from "@/lib/close-api/decisions";
import { xlmToStroops } from "@/lib/utils/amounts";

function isSorobanStep(s: PlannedStep): boolean {
  return (
    s.type === "EXIT_POSITIONS" ||
    (s.type === "HANDLE_ASSETS" &&
      s.affectedAsset !== undefined &&
      isTokenContract(s.affectedAsset))
  );
}

/**
 * The plan's fee: the sum of its steps' fees, split by how each part is known. A classic step
 * pays the base fee per operation; a Soroban step carries its own estimate (`planExitSteps`,
 * `buildPlan`), of which only an exit's first transaction can come from a simulation.
 */
export function planFeeEstimate(
  steps: readonly PlannedStep[],
  simulatedExitFees: ReadonlyMap<string, bigint>
): Omit<PlanEstimate, "freedReserveXlm"> {
  let classic = 0n;
  let simulated = 0n;
  let bound = 0n;
  for (const s of steps) {
    const fee = BigInt(xlmToStroops(s.estimatedFeeLumens));
    if (!isSorobanStep(s)) {
      classic += fee;
      continue;
    }
    const sim =
      s.type === "EXIT_POSITIONS" && s.affectedContract !== undefined
        ? simulatedExitFees.get(s.affectedContract)
        : undefined;
    simulated += sim ?? 0n;
    bound += fee - (sim ?? 0n);
  }
  return {
    feeStroops: String(classic + simulated + bound),
    feeParts: {
      classicStroops: String(classic),
      sorobanSimulatedStroops: String(simulated),
      sorobanBoundStroops: String(bound),
    },
  };
}
