import type { Keypair } from "@stellar/stellar-sdk";
import { getMediatorPublicKey, type Network } from "@/config/networks";
import {
  isRegistryFresh,
  lookupExchange,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import { readNativeBalance } from "@/lib/stellar/account-state";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";

export type Clock = () => Date;
export const CLOCK = Symbol("CLOCK");
export const defaultClock: Clock = () => new Date();

export interface ExchangeRegistryPort {
  lookup: typeof lookupExchange;
  isFresh: (now: Date) => boolean;
  requiresMediator: typeof requiresMediatorForAddress;
}
export const EXCHANGE_REGISTRY = Symbol("EXCHANGE_REGISTRY");
export const defaultExchangeRegistry: ExchangeRegistryPort = {
  lookup: lookupExchange,
  isFresh: isRegistryFresh,
  requiresMediator: requiresMediatorForAddress,
};

export interface AccountReaderPort {
  readNativeBalance: typeof readNativeBalance;
}
export const ACCOUNT_READER = Symbol("ACCOUNT_READER");
export const defaultAccountReader: AccountReaderPort = { readNativeBalance };

export interface MediatorKeyProvider {
  keypair(network: Network): Keypair | null;
  configuredPublicKey(network: Network): string;
}
export const MEDIATOR_KEY_PROVIDER = Symbol("MEDIATOR_KEY_PROVIDER");
export const defaultMediatorKeyProvider: MediatorKeyProvider = {
  keypair: (network) => getMediatorKeypair(network),
  configuredPublicKey: (network) => getMediatorPublicKey(network),
};
