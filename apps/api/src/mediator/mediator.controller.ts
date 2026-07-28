import { Body, Controller, Get, HttpCode, HttpException, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Transaction } from "@stellar/stellar-sdk";
import { MediatorSignRequestDto } from "./dto/mediator-sign.dto";
import { isValidNetwork, NETWORK_PASSPHRASES, getMediatorPublicKey } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { lookupExchange } from "@/lib/exchange-registry";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";
import { getAccountState } from "@/lib/stellar/account";
import { AccountNotFoundError } from "@/lib/utils/errors";

@ApiTags("mediator")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiResponse({ status: 401, description: "Missing or invalid API key." })
@ApiResponse({ status: 429, description: "Rate limit exceeded for this key." })
@Controller(":network/mediator")
export class MediatorController {
  /**
   * Co-signs the shared-mediator forward payment. Validates the exact
   * [accountMerge → mediator, payment mediator → destination] shape and only
   * then adds the mediator signature; it can never change destination/amount.
   */
  @Post("sign")
  @HttpCode(200)
  @ApiOperation({ summary: "Co-sign the mediator forwarding payment of an exchange close." })
  @ApiBody({ type: MediatorSignRequestDto })
  @ApiResponse({ status: 200, description: "The transaction with the mediator signature added (base64 XDR)." })
  @ApiResponse({ status: 400, description: "Missing/invalid transaction or disallowed structure." })
  @ApiResponse({ status: 503, description: "Mediator flow not configured on this server." })
  async sign(@Param("network") network: string, @Body() body: { transaction?: string }) {
    if (!isValidNetwork(network)) throw new HttpException({ error: "Invalid network" }, 400);

    const mediatorKeypair = getMediatorKeypair(network);
    if (!mediatorKeypair) {
      throw new HttpException(
        { error: "Exchange (mediator) flow is not configured on this server." },
        503
      );
    }
    const mediator = mediatorKeypair.publicKey();

    const configuredPublic = getMediatorPublicKey(network);
    if (configuredPublic && configuredPublic !== mediator) {
      throw new HttpException({ error: "Mediator key misconfiguration" }, 500);
    }

    if (!body?.transaction) throw new HttpException({ error: "Missing transaction" }, 400);

    let tx: Transaction;
    try {
      tx = new Transaction(body.transaction, NETWORK_PASSPHRASES[network]);
    } catch {
      throw new HttpException({ error: "Invalid transaction XDR" }, 400);
    }

    const [merge, transfer] = tx.operations;

    if (
      tx.operations.length !== 2 ||
      merge?.type !== "accountMerge" ||
      transfer?.type !== "payment"
    ) {
      throw new HttpException({ error: "Transaction structure not allowed" }, 400);
    }

    if (
      merge.source === mediator ||
      merge.destination !== mediator ||
      transfer.source !== mediator ||
      transfer.destination === mediator ||
      !transfer.asset.isNative() ||
      parseFloat(transfer.amount) < 1
    ) {
      throw new HttpException({ error: "Transaction structure not allowed" }, 400);
    }

    tx.sign(mediatorKeypair);
    return { transaction: tx.toEnvelope().toXDR("base64") };
  }

  @Get("check/:address")
  @ApiOperation({ summary: "Check whether a destination needs the mediator flow and/or a memo." })
  @ApiParam({ name: "address", description: "Destination account (G...)." })
  @ApiResponse({ status: 200, description: "Mediator/memo requirements for the destination." })
  @ApiResponse({ status: 400, description: "Invalid network or address." })
  async check(@Param("network") network: string, @Param("address") address: string) {
    if (!isValidNetwork(network)) throw new HttpException({ error: "Invalid network" }, 400);
    if (!isValidGAddress(address)) throw new HttpException({ error: "Invalid address" }, 400);

    // Whether this server can actually co-sign the mediator flow (secret configured).
    const available = getMediatorKeypair(network) !== null;

    const exchange = lookupExchange(address);
    if (exchange) {
      return {
        requiresMediator: exchange.requiresMediator,
        reason: `${exchange.name} does not support direct account merges.`,
        requiresMemo: exchange.requiresMemo,
        memoType: exchange.memoType,
        exchangeName: exchange.name,
        available,
      };
    }

    try {
      await getAccountState(address, network);
      return {
        requiresMediator: false,
        reason: "Destination account exists and supports account merges.",
        requiresMemo: false,
        memoType: null,
        exchangeName: null,
        available,
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
        };
      }
      throw err;
    }
  }
}
