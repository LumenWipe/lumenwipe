import { Module } from "@nestjs/common";
import { StatsModule } from "@/stats/stats.module";
import { CloseController } from "./close.controller";

@Module({
  imports: [StatsModule],
  controllers: [CloseController],
})
export class CloseModule {}
