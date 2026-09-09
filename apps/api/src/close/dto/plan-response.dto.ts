import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  CloseApiStatus,
  DecisionOption,
  DecisionPoint,
  ExecutionTxBreakdown,
  PlanResponse,
  QuoteInfo,
} from "@lumenwipe/types";
import type { PlannedStep, StepStatus, StepType } from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

const CLOSE_API_STATUSES: CloseApiStatus[] = ["ready", "needs_decisions", "blocked", "complete"];

const STEP_TYPES: StepType[] = [
  "NORMALIZE_SIGNERS",
  "REVOKE_SPONSORSHIP",
  "REMOVE_DATA_ENTRIES",
  "CANCEL_OFFERS",
  "ADD_TRUSTLINE_FOR_CLAIM",
  "CLAIM_BALANCES",
  "EXIT_POSITIONS",
  "HANDLE_ASSETS",
  "REMOVE_TRUSTLINES",
  "CLOSE_ACCOUNT",
  "MERGE",
];

const STEP_STATUSES: StepStatus[] = [
  "pending",
  "signing",
  "submitted",
  "confirmed",
  "failed",
  "skipped",
];

export class PlannedStepDto implements PlannedStep {
  @ApiProperty({ description: "Position in the plan's step list, from 0." })
  index!: number;

  @ApiProperty({ enum: STEP_TYPES })
  type!: StepType;

  @ApiProperty({ description: "Short, human-readable title for display." })
  title!: string;

  @ApiProperty({ description: "Longer, human-readable description for display." })
  description!: string;

  @ApiProperty({ description: "Number of operations this step's transaction will contain." })
  operationCount!: number;

  @ApiProperty({
    description: "Estimated fee in XLM, before the step actually builds/submits.",
    example: "0.0000100",
  })
  estimatedFeeLumens!: string;

  @ApiProperty({
    description: "Populated lazily at execution time - null until the step is actually built.",
    type: "string",
    nullable: true,
  })
  txXdr!: string | null;

  @ApiProperty({ enum: STEP_STATUSES })
  status!: StepStatus;

  @ApiProperty({
    description: "Populated once submitted - null before then.",
    type: "string",
    nullable: true,
  })
  txHash!: string | null;

  @ApiProperty({
    description: "Populated only if the step failed - null otherwise.",
    type: "string",
    nullable: true,
  })
  error!: string | null;

  @ApiPropertyOptional({
    description:
      'What the user\'s own account paid for this step, once confirmed - exactly "0" when a ' +
      "dedicated sponsor account covered the fee-bump instead. Absent until the step confirms.",
  })
  actualFeeLumens?: string;

  @ApiPropertyOptional({ description: "For HANDLE_ASSETS steps: the affected asset." })
  affectedAsset?: string;

  @ApiPropertyOptional({ description: "For EXIT_POSITIONS steps: the pool, pair, or vault left." })
  affectedContract?: string;

  @ApiPropertyOptional({
    description:
      "Set when no DEX path exists and the user confirmed sending to the issuer instead.",
  })
  fallbackToIssuer?: boolean;
}

export class QuoteInfoDto implements QuoteInfo {
  @ApiProperty({ description: "Estimated amount received.", example: "42.5000000" })
  estimatedReceive!: string;

  @ApiProperty({
    description: "Intermediate assets the route swaps through, in order.",
    type: [String],
  })
  path!: string[];

  @ApiProperty({ enum: ["soroswap", "sdex"] })
  source!: "soroswap" | "sdex";

  @ApiProperty({ description: "The ledger this quote is no longer valid past." })
  expiresAtLedger!: number;
}

export class DecisionOptionDto implements DecisionOption {
  @ApiProperty({
    description:
      'One of a decision-type-specific set, e.g. "convert_to_xlm" | "return_to_issuer" | "transfer_to_account" | "acknowledged".',
  })
  id!: string;

  @ApiPropertyOptional({ description: "Whether this is the option the plan recommends." })
  recommended?: boolean;

  @ApiPropertyOptional({ type: QuoteInfoDto })
  quote?: QuoteInfo;

  @ApiPropertyOptional({ description: "Plain-language note about this option." })
  note?: string;
}

export class DecisionPointDto implements DecisionPoint {
  @ApiProperty({ description: 'Stable id, e.g. "asset:USDC-GISSUER...".' })
  id!: string;

  @ApiProperty({ enum: ["asset_disposition", "confirmation", "choice", "claimable_balance"] })
  type!: "asset_disposition" | "confirmation" | "choice" | "claimable_balance";

  @ApiProperty({
    description:
      "The subject of this decision - shape depends on `type` (e.g. an asset code/issuer/balance " +
      "for asset_disposition, a claimable balance id for claimable_balance). Freeform by design: " +
      "there is one decision-point contract per `type`, not one global shape.",
    type: "object",
    additionalProperties: true,
  })
  subject!: Record<string, unknown>;

  @ApiProperty({ type: [DecisionOptionDto] })
  options!: DecisionOption[];

  @ApiProperty({ description: "The option id applied if the caller never answers this decision." })
  default!: string;

  @ApiProperty({ description: "Whether an answer is mandatory before the plan can proceed." })
  required!: boolean;
}

export class ExecutionTxBreakdownDto implements ExecutionTxBreakdown {
  @ApiProperty({ description: "Position among the transactions this plan will take to execute." })
  order!: number;

  @ApiProperty({ enum: STEP_TYPES, isArray: true })
  covers!: StepType[];

  @ApiPropertyOptional({
    description: "Why this transaction is split from the previous one, when it is.",
    enum: ["op_batch", "defi_dependency"],
  })
  reason?: "op_batch" | "defi_dependency";
}

export class PlanResponseBlockerDto {
  @ApiProperty({ description: "Stable machine-readable code for this blocker." })
  code!: string;

  @ApiProperty({ description: "Plain-language explanation." })
  message!: string;

  @ApiPropertyOptional({ description: "A docs link with more detail." })
  helpUrl?: string;
}

class PlanEstimateDto {
  @ApiProperty({ description: "Estimated total fee across every transaction, in stroops." })
  feeStroops!: string;

  @ApiProperty({ description: "Estimated XLM freed by removing subentries, in XLM." })
  freedReserveXlm!: string;
}

class PlanExecutionDto {
  @ApiProperty({ description: "Estimated number of transactions this close will take." })
  estimatedTransactionCount!: number;

  @ApiProperty({ type: [ExecutionTxBreakdownDto] })
  transactions!: ExecutionTxBreakdown[];
}

export class PlanResponseDto implements PlanResponse {
  @ApiProperty({
    description:
      "Deterministic hash of this plan's content - unchanged inputs yield the same hash.",
  })
  planHash!: string;

  @ApiProperty({ enum: CLOSE_API_STATUSES })
  status!: CloseApiStatus;

  @ApiProperty({ type: [PlannedStepDto] })
  steps!: unknown[];

  @ApiProperty({ type: [DecisionPointDto] })
  decisionPoints!: DecisionPoint[];

  @ApiProperty({ type: [PlanResponseBlockerDto] })
  blockers!: { code: string; message: string; helpUrl?: string }[];

  @ApiProperty({ type: PlanEstimateDto })
  estimate!: { feeStroops: string; freedReserveXlm: string };

  @ApiProperty({ type: PlanExecutionDto })
  execution!: { estimatedTransactionCount: number; transactions: ExecutionTxBreakdown[] };
}
