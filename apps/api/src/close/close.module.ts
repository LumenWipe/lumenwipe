import { Module } from "@nestjs/common";
import { CloseController } from "./close.controller";

@Module({
  controllers: [CloseController],
})
export class CloseModule {}
