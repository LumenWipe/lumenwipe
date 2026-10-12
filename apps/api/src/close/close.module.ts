import { Module } from "@nestjs/common";
import { StatsModule } from "@/stats/stats.module";
import { CloseController } from "./close.controller";
import { CloseService } from "./close.service";
import {
  CLOCK,
  CLOSE_BUILDER,
  CLOSE_READER,
  EXCHANGE_REGISTRY,
  RPC_SERVER_FACTORY,
  TRANSACTION_SUBMITTER,
  defaultClock,
  defaultCloseBuilder,
  defaultCloseReader,
  defaultExchangeRegistry,
  defaultRpcServerFactory,
  submitterFor,
  type RpcServerFactory,
} from "@/common/ports";

@Module({
  imports: [StatsModule],
  controllers: [CloseController],
  providers: [
    CloseService,
    { provide: CLOSE_READER, useValue: defaultCloseReader },
    { provide: CLOSE_BUILDER, useValue: defaultCloseBuilder },
    { provide: EXCHANGE_REGISTRY, useValue: defaultExchangeRegistry },
    { provide: CLOCK, useValue: defaultClock },
    { provide: RPC_SERVER_FACTORY, useValue: defaultRpcServerFactory },
    {
      provide: TRANSACTION_SUBMITTER,
      useFactory: (serverFor: RpcServerFactory) => submitterFor(serverFor),
      inject: [RPC_SERVER_FACTORY],
    },
  ],
})
export class CloseModule {}
