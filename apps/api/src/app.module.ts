import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { HealthController } from "./health/health.controller";
import { CloseModule } from "./close/close.module";
import { AccountModule } from "./account/account.module";
import { MediatorModule } from "./mediator/mediator.module";
import { ApiKeyService } from "./auth/api-key.service";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { ApiKeyThrottlerGuard } from "./auth/api-key-throttler.guard";
import { MeteringService } from "./metering/metering.service";
import { MeteringInterceptor } from "./metering/metering.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Per-API-key rate limit (tracker in ApiKeyThrottlerGuard); defaults to 120
    // requests / minute, overridable via env for different environments.
    ThrottlerModule.forRoot([
      {
        ttl: process.env.THROTTLE_TTL ? Number(process.env.THROTTLE_TTL) : 60_000,
        limit: process.env.THROTTLE_LIMIT ? Number(process.env.THROTTLE_LIMIT) : 120,
      },
    ]),
    CloseModule,
    AccountModule,
    MediatorModule,
  ],
  controllers: [HealthController],
  providers: [
    ApiKeyService,
    MeteringService,
    // Order matters: authenticate first, then rate-limit (the throttler keys off
    // the API key), then meter successful requests.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ApiKeyThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: MeteringInterceptor },
  ],
})
export class AppModule {}
