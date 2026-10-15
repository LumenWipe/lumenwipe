import { Module } from "@nestjs/common";
import { FeeBumpController } from "./fee-bump.controller";
import { SPONSORSHIP_BUDGET, SponsorshipBudget } from "./sponsorship-budget";
import {
  ACCOUNT_SEQUENCE_READER,
  CLOCK,
  defaultAccountSequenceReader,
  defaultClock,
} from "@/common/ports";

@Module({
  controllers: [FeeBumpController],
  providers: [
    { provide: SPONSORSHIP_BUDGET, useValue: new SponsorshipBudget() },
    { provide: CLOCK, useValue: defaultClock },
    { provide: ACCOUNT_SEQUENCE_READER, useValue: defaultAccountSequenceReader },
  ],
})
export class FeeBumpModule {}
