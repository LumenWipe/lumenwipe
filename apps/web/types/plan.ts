/**
 * Plan types, re-exported from the shared contract package.
 *
 * This file used to be a verbatim copy of `packages/types/src/plan.ts` (#68). The copies had
 * already drifted - the web one carried an extra type - and adding the transfer disposition would
 * have made a shared union differ between the app and the contract it speaks. Re-exporting the
 * shared names keeps one definition; only genuinely web-only types are declared below.
 *
 * Named rather than `export *`: the package's entry point re-exports account and close-api types
 * too, which would collide with the local `@/types/account` and `@/types/close-api` modules.
 */
export type {
  AssetDisposition,
  BuildPlanResult,
  // Already defined in the package (close-api.ts); the local copy here was a third duplicate,
  // not a web-only type.
  ClaimableBalanceSelection,
  ConversionPath,
  DemolishPhase,
  PlanBlocker,
  PlannedStep,
  StepStatus,
  StepType,
  TransferDestinations,
} from "@lumenwipe/types";
