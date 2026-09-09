import { Module } from "@nestjs/common";
import { FeeBumpController } from "./fee-bump.controller";

@Module({
  controllers: [FeeBumpController],
})
export class FeeBumpModule {}
