import { Module } from "@nestjs/common";
import { MeteringService } from "./metering.service";

@Module({
  providers: [MeteringService],
  exports: [MeteringService],
})
export class MeteringModule {}
