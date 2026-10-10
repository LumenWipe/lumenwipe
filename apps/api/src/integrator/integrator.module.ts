import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { AuditLogger } from "@/common/audit-logger";
import { MeteringModule } from "@/metering/metering.module";
import { IntegratorController } from "./integrator.controller";
import { IntegratorGuard } from "./integrator.guard";

@Module({
  imports: [AuthModule, MeteringModule],
  controllers: [IntegratorController],
  providers: [IntegratorGuard, AuditLogger],
})
export class IntegratorModule {}
