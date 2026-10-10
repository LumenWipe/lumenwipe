import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Transaction } from "@stellar/stellar-sdk";
import { MediatorSignRequestDto } from "./dto/mediator-sign.dto";
import { MediatorCheckResultDto, MediatorSignResponseDto } from "./dto/mediator-responses.dto";
import { ApiErrorResponse, ApiBodyErrorResponses } from "@/common/api-error-response.decorator";
import { NETWORK_PASSPHRASES, getMediatorPublicKey, type Network } from "@/config/networks";
import { NetworkFirstGuard } from "@/common/guards/network-first.guard";
import { GAddressPipe } from "@/common/pipes/g-address.pipe";
import { NetworkPipe } from "@/common/pipes/network.pipe";
import { isValidGAddress } from "@/lib/utils/validation";
import { lookupExchange } from "@/lib/exchange-registry";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";
import { readNativeBalance } from "@/lib/stellar/account-state";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { forwardExceedsMergedBalance } from "./mediator-validation";
import { fail } from "@/common/fail";

@ApiTags("mediator")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller(":network/mediator")
export class MediatorController {
  /**
   * Co-signs the shared-mediator forward payment. Validates the exact
   * [accountMerge → mediator, payment mediator → destination] shape and only
   * then adds the mediator signature; it can never change destination/amount.
   */
  @ApiErrorResponse(400, "Missing/invalid transaction or disallowed structure.", [
    "invalid_network",
    "missing_transaction",
    "invalid_transaction_xdr",
    "transaction_structure_not_allowed",
    "merged_account_not_found",
    "forward_amount_exceeds_balance",
    "invalid_body",
  ])
  @ApiErrorResponse(500, "The mediator key is misconfigured.", ["mediator_key_misconfiguration"])
  @ApiErrorResponse(503, "Mediator flow not configured on this server.", [
    "mediator_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("sign")
  @HttpCode(200)
  @ApiOperation({ summary: "Co-sign the mediator forwarding payment of an exchange close." })
  @ApiBody({ type: MediatorSignRequestDto })
  @ApiResponse({
    status: 200,
    description: "The transaction with the mediator signature added (base64 XDR).",
    type: MediatorSignResponseDto,
  })
  async sign(
    @Param("network", new NetworkPipe("Invalid network")) network: Network,
    @Body() body: { transaction?: string }
  ) {
    const mediatorKeypair = getMediatorKeypair(network);
    if (!mediatorKeypair) {
      fail(
        "mediator_not_configured",
        "Exchange (mediator) flow is not configured on this server.",
        503
      );
    }
    const mediator = mediatorKeypair.publicKey();

    const configuredPublic = getMediatorPublicKey(network);
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
      mergedBalance = (await readNativeBalance(mergedSource, network)).nativeBalanceLumens;
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

  @ApiErrorResponse(400, "Invalid network or address.", ["invalid_network", "invalid_address"])
  @UseGuards(new NetworkFirstGuard("Invalid network"))
  @Get("check/:address")
  @ApiOperation({ summary: "Check whether a destination needs the mediator flow and/or a memo." })
  @ApiParam({ name: "address", description: "Destination account (G...)." })
  @ApiResponse({
    status: 200,
    description: "Mediator/memo requirements for the destination.",
    type: MediatorCheckResultDto,
  })
  async check(
    @Param("network", new NetworkPipe("Invalid network")) network: `${Network}`,
    @Param("address", new GAddressPipe("invalid_address", "Invalid address")) address: string
  ) {
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
      await readNativeBalance(address, network);
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
