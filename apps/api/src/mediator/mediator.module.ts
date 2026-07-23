import { Module } from "@nestjs/common";
import { MediatorController } from "./mediator.controller";

@Module({
  controllers: [MediatorController],
})
export class MediatorModule {}
