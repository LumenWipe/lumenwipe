import type { Keypair, rpc } from "@stellar/stellar-sdk";
import { getMediatorPublicKey, type Network } from "@/config/networks";
import {
  isRegistryFresh,
  lookupExchange,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import { readNativeBalance, readTrustlinesOnly } from "@/lib/stellar/account-state";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { planBatch } from "@/lib/close-api/batch-plan";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { assessMergePreflight } from "@/lib/close-api/merge-preflight";
import { readAccountState } from "@/lib/close-api/read-account";
import { validateTransferDestinations } from "@/lib/close-api/transfer-destinations";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait, type SubmitResult } from "@/lib/stellar/submit";
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

export type RpcServerFactory = (network: Network) => rpc.Server;
export const RPC_SERVER_FACTORY = Symbol("RPC_SERVER_FACTORY");
export const defaultRpcServerFactory: RpcServerFactory = getRpcServer;

export interface CloseReaderPort {
  readAccountState: typeof readAccountState;
  readTrustlinesOnly: typeof readTrustlinesOnly;
  buildAccountPlan: typeof buildAccountPlan;
  planBatch: typeof planBatch;
}
export const CLOSE_READER = Symbol("CLOSE_READER");
export const defaultCloseReader: CloseReaderPort = {
  readAccountState: (...args) => readAccountState(...args),
  readTrustlinesOnly: (...args) => readTrustlinesOnly(...args),
  buildAccountPlan: (...args) => buildAccountPlan(...args),
  planBatch: (...args) => planBatch(...args),
};

export interface CloseBuilderPort {
  buildCloseTransactions: typeof buildCloseTransactions;
  assessMergePreflight: typeof assessMergePreflight;
  validateTransferDestinations: typeof validateTransferDestinations;
}
export const CLOSE_BUILDER = Symbol("CLOSE_BUILDER");
export const defaultCloseBuilder: CloseBuilderPort = {
  buildCloseTransactions: (...args) => buildCloseTransactions(...args),
  assessMergePreflight: (...args) => assessMergePreflight(...args),
  validateTransferDestinations: (...args) => validateTransferDestinations(...args),
};

export interface TransactionSubmitterPort {
  submitAndWait(signedXdr: string, network: Network): Promise<SubmitResult>;
}
export const TRANSACTION_SUBMITTER = Symbol("TRANSACTION_SUBMITTER");
export const submitterFor = (serverFor: RpcServerFactory): TransactionSubmitterPort => ({
  submitAndWait: (signedXdr, network) => submitAndWait(signedXdr, network, undefined, serverFor),
});
