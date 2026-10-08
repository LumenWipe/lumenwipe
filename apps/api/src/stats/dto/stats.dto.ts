import { ApiProperty } from "@nestjs/swagger";
import type {
  DailyActivity,
  MergeRecord,
  Network,
  RecordMergeResponse,
  StatsFeed,
  StatsTotals,
} from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

export class RecordMergeRequestDto {
  @ApiProperty({
    description: "Hash of a confirmed transaction that merged the account being closed.",
    example: "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
  })
  txHash!: string;
}

export class RecordMergeResponseDto implements RecordMergeResponse {
  @ApiProperty({
    description: "True when this call counted the close; false when the hash was already counted.",
    example: true,
  })
  counted!: boolean;
}

export class StatsTotalsDto implements StatsTotals {
  @ApiProperty({ enum: ["testnet", "mainnet"], example: "mainnet" })
  network!: Network;

  @ApiProperty({ description: "Accounts closed through LumenWipe.", example: 1284 })
  accountsClosed!: number;

  @ApiProperty({
    description: "XLM recovered by those closes, in stroops, as a decimal string.",
    example: "52310000000",
  })
  xlmRecoveredStroops!: string;
}

export class MergeRecordDto implements MergeRecord {
  @ApiProperty({ example: "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889" })
  txHash!: string;

  @ApiProperty({ enum: ["testnet", "mainnet"], example: "mainnet" })
  network!: Network;

  @ApiProperty({ description: "Accounts this transaction merged.", example: 1 })
  accountsClosed!: number;

  @ApiProperty({ description: "XLM the merges moved, in stroops.", example: "45000000" })
  xlmStroops!: string;

  @ApiProperty({
    description: "Ledger close time, ISO 8601.",
    example: "2026-10-08T14:03:11.000Z",
  })
  timestamp!: string;
}

export class DailyActivityDto implements DailyActivity {
  @ApiProperty({ description: "UTC day.", example: "2026-10-08" })
  date!: string;

  @ApiProperty({ example: 7 })
  accountsClosed!: number;
}

export class StatsFeedDto implements StatsFeed {
  @ApiProperty({ type: StatsTotalsDto })
  totals!: StatsTotalsDto;

  @ApiProperty({ type: [MergeRecordDto], description: "The 50 most recent closes, newest first." })
  recent!: MergeRecordDto[];

  @ApiProperty({
    type: [DailyActivityDto],
    description: "The last 365 UTC days, oldest first, zero-filled.",
  })
  daily!: DailyActivityDto[];
}
