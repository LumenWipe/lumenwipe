import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { MeteringModule } from "@/metering/metering.module";
import { ApiKeysAdminController } from "./api-keys.controller";

@Module({
  imports: [AuthModule, MeteringModule],
  controllers: [ApiKeysAdminController],
})
export class AdminModule {}
