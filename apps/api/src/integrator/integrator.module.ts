import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { MeteringModule } from "@/metering/metering.module";
import { IntegratorController } from "./integrator.controller";
import { IntegratorGuard } from "./integrator.guard";

@Module({
  imports: [AuthModule, MeteringModule],
  controllers: [IntegratorController],
  providers: [IntegratorGuard],
})
export class IntegratorModule {}
