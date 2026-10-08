import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "./health/health.controller";
import { RootController } from "./root.controller";
import { RegistryController } from "./config-api/registry.controller";
import { CloseModule } from "./close/close.module";
import { AccountModule } from "./account/account.module";
import { MediatorModule } from "./mediator/mediator.module";
import { FeeBumpModule } from "./fee-bump/fee-bump.module";
import { AdminModule } from "./admin/admin.module";
import { IntegratorModule } from "./integrator/integrator.module";
import { AuthModule } from "./auth/auth.module";
import { ApiKeyGuard } from "./auth/api-key.guard";
import { ApiKeyThrottlerGuard } from "./auth/api-key-throttler.guard";
import { MeteringModule } from "./metering/metering.module";
import { MeteringInterceptor } from "./metering/metering.interceptor";

/** Reads a positive integer from env, falling back on missing/invalid values. */
function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.local", ".env"] }),
    // Per-API-key rate limit (tracker + key in ApiKeyThrottlerGuard); defaults
    // to 120 requests / minute, overridable via env. A non-numeric override
    // falls back to the default rather than silently disabling the limit.
    ThrottlerModule.forRoot([
      { ttl: positiveIntEnv("THROTTLE_TTL", 60_000), limit: positiveIntEnv("THROTTLE_LIMIT", 120) },
    ]),
    TerminusModule.forRoot(),
    AuthModule,
    MeteringModule,
    CloseModule,
    AccountModule,
    MediatorModule,
    FeeBumpModule,
    AdminModule,
    IntegratorModule,
  ],
  controllers: [RootController, HealthController, RegistryController],
  providers: [
    // Order matters: rate-limit BEFORE authenticating, then meter successful requests.
    // ApiKeyThrottlerGuard's tracker reads the raw Authorization header itself (falling back to
    // the caller's IP when there is none) - it never depends on ApiKeyGuard having already run,
    // so this order costs nothing for real traffic. It buys real protection for a request with
    // no key, or an invalid one: previously ApiKeyGuard's 401 threw before the throttler ever
    // saw the request, so an unauthenticated flood was entirely unthrottled at the app layer
    // (#59) - every 401 still cost a guard evaluation with no budget capping how often that
    // could happen. Now it shares the same per-key/per-IP budget as everything else.
    { provide: APP_GUARD, useClass: ApiKeyThrottlerGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: MeteringInterceptor },
  ],
})
export class AppModule {}
