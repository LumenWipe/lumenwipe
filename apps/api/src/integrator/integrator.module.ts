import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { AuditLogger } from "@/common/audit-logger";
import { MeteringModule } from "@/metering/metering.module";
import { CONTRACT_AUTH_NETWORK } from "./contract-auth";
import { rpcContractAuthNetwork } from "./contract-auth-network";
import { IntegratorController } from "./integrator.controller";
import { IntegratorGuard } from "./integrator.guard";
import { USED_CHALLENGE_STORE, createUsedChallengeStore } from "./used-challenge-store";

@Module({
  imports: [AuthModule, MeteringModule],
  controllers: [IntegratorController],
  providers: [
    IntegratorGuard,
    AuditLogger,
    { provide: USED_CHALLENGE_STORE, useFactory: createUsedChallengeStore },
    { provide: CONTRACT_AUTH_NETWORK, useValue: rpcContractAuthNetwork },
  ],
})
export class IntegratorModule {}
