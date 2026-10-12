import { Inject, Injectable } from "@nestjs/common";
import { Transaction } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { forwardExceedsMergedBalance } from "./mediator-validation";
import { fail } from "@/common/fail";
import {
  ACCOUNT_READER,
  CLOCK,
  EXCHANGE_REGISTRY,
  MEDIATOR_KEY_PROVIDER,
  type AccountReaderPort,
  type Clock,
  type ExchangeRegistryPort,
  type MediatorKeyProvider,
} from "@/common/ports";

@Injectable()
export class MediatorSigningService {
  constructor(
    @Inject(MEDIATOR_KEY_PROVIDER) private readonly keys: MediatorKeyProvider,
    @Inject(EXCHANGE_REGISTRY) private readonly registry: ExchangeRegistryPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACCOUNT_READER) private readonly accounts: AccountReaderPort
  ) {}

  /**
   * Co-signs the shared-mediator forward payment. Validates the exact
   * [accountMerge → mediator, payment mediator → destination] shape and only
   * then adds the mediator signature; it can never change destination/amount.
   */
  async sign(network: Network, body: { transaction?: string }): Promise<{ transaction: string }> {
    const mediatorKeypair = this.keys.keypair(network);
    if (!mediatorKeypair) {
      fail(
        "mediator_not_configured",
        "Exchange (mediator) flow is not configured on this server.",
        503
      );
    }
    const mediator = mediatorKeypair.publicKey();

    const configuredPublic = this.keys.configuredPublicKey(network);
    if (configuredPublic && configuredPublic !== mediator) {
      fail("mediator_key_misconfiguration", "Mediator key misconfiguration", 500);
    }

    if (!body?.transaction) fail("missing_transaction", "Missing transaction", 400);

    let tx: Transaction;
    try {
      tx = new Transaction(body.transaction, NETWORK_PASSPHRASES[network]);
    } catch {
      fail("invalid_transaction_xdr", "Invalid transaction XDR", 400);
    }

    const [merge, transfer] = tx.operations;

    if (
      tx.operations.length !== 2 ||
      merge?.type !== "accountMerge" ||
      transfer?.type !== "payment"
    ) {
      fail("transaction_structure_not_allowed", "Transaction structure not allowed", 400);
    }

    if (
      merge.source === mediator ||
      merge.destination !== mediator ||
      transfer.source !== mediator ||
      transfer.destination === mediator ||
      !transfer.asset.isNative() ||
      parseFloat(transfer.amount) < 1
    ) {
      fail("transaction_structure_not_allowed", "Transaction structure not allowed", 400);
    }

    // The mediator must not be the transaction's fee/sequence source (that would consume
    // its sequence number and make it pay the fee) nor the account being merged.
    const mergedSource = merge.source ?? tx.source;
    if (tx.source === mediator || mergedSource === mediator || !isValidGAddress(mergedSource)) {
      fail("transaction_structure_not_allowed", "Transaction structure not allowed", 400);
    }

    // Bound the forward payment to what the merge delivers - defense-in-depth against a
    // naive/accidental over-forward on this public endpoint. This is not a full guarantee
    // against an active adversary (see forwardExceedsMergedBalance for the TOCTOU limit);
    // the primary protection stays the operational invariant that the mediator holds no
    // surplus. Fail closed: if the balance can't be read, do not co-sign.
    let mergedBalance: string;
    try {
      mergedBalance = (await this.accounts.readNativeBalance(mergedSource, network))
        .nativeBalanceLumens;
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        fail("merged_account_not_found", "Merged account not found", 400);
      }
      throw err;
    }
    if (forwardExceedsMergedBalance(transfer.amount, mergedBalance, Number(tx.fee))) {
      fail("forward_amount_exceeds_balance", "Forward amount exceeds the merged balance", 400);
    }

    tx.sign(mediatorKeypair);
    return { transaction: tx.toEnvelope().toXDR("base64") };
  }

  async checkDestination(network: Network, address: string) {
    // Whether this server can actually co-sign the mediator flow (secret configured).
    const available = this.keys.keypair(network) !== null;
    const registryFresh = this.registry.isFresh(this.clock());

    const exchange = this.registry.lookup(address);
    if (exchange) {
      return {
        requiresMediator: exchange.requiresMediator,
        reason: `${exchange.name} does not support direct account merges.`,
        requiresMemo: exchange.requiresMemo,
        memoType: exchange.memoType,
        exchangeName: exchange.name,
        available,
        registryFresh,
      };
    }

    try {
      await this.accounts.readNativeBalance(address, network);
      return {
        requiresMediator: false,
        reason: "Destination account exists and supports account merges.",
        requiresMemo: false,
        memoType: null,
        exchangeName: null,
        available,
        registryFresh,
      };
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        return {
          requiresMediator: false,
          reason: "Destination account does not exist yet. Merging into it will create it.",
          requiresMemo: false,
          memoType: null,
          exchangeName: null,
          available,
          registryFresh,
        };
      }
      throw err;
    }
  }
}
