import { ApiExtraModels, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  CloseApiStatus,
  CloseTransaction,
  IntentOperation,
  TransactionsResponse,
  TxIntent,
} from "@lumenwipe/types";
import type { StepType } from "@lumenwipe/types";
import {
  INTENT_OPERATION_EXTRA_MODELS,
  intentOperationSchema,
} from "./intent-operation-responses.dto";

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

class TxGuaranteesDto {
  @ApiProperty({
    description: "The only address this transaction may merge into, or null if it merges nothing.",
    type: "string",
    nullable: true,
  })
  mergeDestination!: string | null;

  @ApiProperty({
    description:
      "Every address this transaction pays to - a payment op to anywhere else fails verification.",
    type: [String],
  })
  paymentsOnlyTo!: string[];

  @ApiProperty({
    description:
      "The least XLM any conversion in this transaction is allowed to deliver, or null if none.",
    type: "string",
    nullable: true,
  })
  minXlmFromConversions!: string | null;
}

@ApiExtraModels(...INTENT_OPERATION_EXTRA_MODELS)
export class TxIntentDto implements TxIntent {
  @ApiProperty({ description: "Human-readable summary of what this transaction does." })
  summary!: string;

  @ApiProperty({ description: "The account this transaction acts as (G...)." })
  source!: string;

  @ApiProperty({ description: "Transaction fee, in stroops." })
  fee!: string;

  @ApiProperty({ type: "string", nullable: true })
  memo!: string | null;

  @ApiProperty({ enum: ["text", "id", "hash"], nullable: true, type: "string" })
  memoType!: "text" | "id" | "hash" | null;

  @ApiProperty({ type: TxGuaranteesDto })
  guarantees!: {
    mergeDestination: string | null;
    paymentsOnlyTo: string[];
    minXlmFromConversions: string | null;
  };

  @ApiProperty({
    description:
      "Every operation this transaction contains, decoded to one of the 11 known shapes.",
    type: "array",
    items: intentOperationSchema(),
  })
  operations!: IntentOperation[];
}

export class CloseTransactionDto implements CloseTransaction {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: "Position among the transactions in this round, from 0." })
  order!: number;

  @ApiProperty({
    description:
      "The ids of transactions in this round that must be submitted and confirmed before this one.",
    type: [String],
  })
  dependsOn!: string[];

  @ApiProperty({ description: "Unsigned transaction envelope, base64 XDR." })
  xdr!: string;

  @ApiProperty()
  networkPassphrase!: string;

  @ApiProperty({
    description: "The source account's sequence number this transaction was built against.",
  })
  sourceSequence!: string;

  @ApiProperty({ description: "The ledger this transaction's time bound expires at." })
  validUntilLedger!: number;

  @ApiProperty({ enum: STEP_TYPES, isArray: true })
  covers!: StepType[];

  @ApiPropertyOptional({
    description:
      "True when the account cannot pay this transaction's own fee without dropping below " +
      "its reserve - the client must route the signed envelope through " +
      "POST /:network/fee-bump/sponsor before submitting it. Absent (not false) otherwise.",
    enum: [true],
  })
  needsSponsoredFee?: true;

  @ApiProperty({ type: TxIntentDto })
  intent!: TxIntent;
}

class RemainingDto {
  @ApiProperty({ description: "Approximate number of build rounds still remaining." })
  steps!: number;

  @ApiProperty({
    description:
      "True when more transactions follow: submit these, wait for confirmation, then request transactions again.",
  })
  requiresAnotherCall!: boolean;
}

export class TransactionsResponseDto implements TransactionsResponse {
  @ApiProperty({
    description:
      "Deterministic hash of this plan's content - unchanged inputs yield the same hash.",
  })
  planHash!: string;

  @ApiProperty({ enum: CLOSE_API_STATUSES })
  status!: CloseApiStatus;

  @ApiProperty({ type: [CloseTransactionDto] })
  transactions!: CloseTransaction[];

  @ApiProperty({ type: RemainingDto })
  remaining!: { steps: number; requiresAnotherCall: boolean };
}
