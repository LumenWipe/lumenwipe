import { Module } from "@nestjs/common";
import { MediatorController } from "./mediator.controller";
import { MediatorSigningService } from "./mediator-signing.service";
import {
  ACCOUNT_READER,
  CLOCK,
  EXCHANGE_REGISTRY,
  MEDIATOR_KEY_PROVIDER,
  defaultAccountReader,
  defaultClock,
  defaultExchangeRegistry,
  defaultMediatorKeyProvider,
} from "@/common/ports";

@Module({
  controllers: [MediatorController],
  providers: [
    MediatorSigningService,
    { provide: MEDIATOR_KEY_PROVIDER, useValue: defaultMediatorKeyProvider },
    { provide: EXCHANGE_REGISTRY, useValue: defaultExchangeRegistry },
    { provide: CLOCK, useValue: defaultClock },
    { provide: ACCOUNT_READER, useValue: defaultAccountReader },
  ],
})
export class MediatorModule {}
