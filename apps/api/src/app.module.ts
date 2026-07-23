import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health/health.controller";
import { CloseModule } from "./close/close.module";
import { AccountModule } from "./account/account.module";
import { MediatorModule } from "./mediator/mediator.module";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), CloseModule, AccountModule, MediatorModule],
  controllers: [HealthController],
})
export class AppModule {}
