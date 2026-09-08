import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { FeeBumpTransaction, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { FeeBumpRequestDto } from "./dto/fee-bump.dto";
import { isAllowedWindDownOperation } from "./fee-bump-validation";
import { isValidNetwork, NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, MAX_FEE_BUMP_STROOPS } from "@/config/constants";
import { getFeeAccountKeypair } from "@/lib/stellar/fee-account";
import { fail } from "@/common/fail";

/**
 * Sponsors the fee of a wind-down transaction for an account that cannot pay its own way
 * (architecture.md §8.1): a reserve-locked account rejects even the base fee with
 * `txINSUFFICIENT_BALANCE`, since paying it would take the account below its reserve.
 *
 * The user builds and signs the inner transaction in the browser exactly as in every other
 * close step, with its own fee left at zero. This endpoint wraps it in a CAP-15 fee-bump
 * envelope whose fee source is a dedicated, lightly funded account, signs only the outer
 * envelope, and returns it - the client submits it through the same `/submit` endpoint every
 * other step uses, unchanged.
 *
 * The inner transaction's own signature covers its exact contents (operations, amounts,
 * destinations, sequence number), so wrapping it cannot alter any of that without invalidating
 * the signature the user already gave - this endpoint decides only WHETHER to sponsor, never
 * what the transaction does. Never returns the outer signature over a transaction whose
 * operations are not all recognized wind-down shapes: an unrelated transaction cannot buy a
 * free fee here just by being handed to this endpoint (threat-model.md §6).
 */
@ApiTags("fee-bump")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiResponse({ status: 401, description: "Missing or invalid API key." })
@ApiResponse({ status: 429, description: "Rate limit exceeded for this key." })
@Controller(":network/fee-bump")
export class FeeBumpController {
  @Post("sponsor")
  @HttpCode(200)
  @ApiOperation({ summary: "Sponsor a wind-down transaction's fee for a reserve-locked account." })
  @ApiBody({ type: FeeBumpRequestDto })
  @ApiResponse({
    status: 200,
    description: "The transaction wrapped in a fee-bump envelope and signed (base64 XDR).",
  })
  @ApiResponse({ status: 400, description: "Missing/invalid transaction or disallowed structure." })
  @ApiResponse({ status: 503, description: "Sponsored-fee flow not configured on this server." })
  async sponsor(@Param("network") network: string, @Body() body: { transaction?: string }) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);

    const feeAccount = getFeeAccountKeypair(network);
    if (!feeAccount) {
      fail(
        "fee_bump_not_configured",
        "Sponsored-fee closes are not configured on this server.",
        503
      );
    }

    if (!body?.transaction) fail("missing_transaction", "Missing transaction", 400);

    const passphrase = NETWORK_PASSPHRASES[network];
    let parsed: Transaction | FeeBumpTransaction;
    try {
      parsed = TransactionBuilder.fromXDR(body.transaction, passphrase);
    } catch {
      fail("invalid_transaction_xdr", "Invalid transaction XDR", 400);
    }
    // A fee-bump envelope cannot itself be wrapped in another fee-bump - CAP-15 has no such
    // construct, and buildFeeBumpTransaction below only accepts a plain Transaction.
    if (!(parsed instanceof Transaction)) {
      fail("invalid_transaction_xdr", "A fee-bump envelope cannot itself be sponsored", 400);
    }
    const tx: Transaction = parsed;

    // The whole point of sponsorship: the inner transaction pays nothing itself, so the account
    // never needs to hold enough to cover its own fee.
    if (tx.fee !== "0") {
      fail(
        "inner_fee_not_zero",
        "The transaction to sponsor must have its own fee set to zero.",
        400
      );
    }

    if (tx.operations.length === 0 || !tx.operations.every(isAllowedWindDownOperation)) {
      fail(
        "operation_not_sponsorable",
        "This transaction contains an operation the sponsored-fee flow does not cover.",
        400
      );
    }

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      String(BASE_FEE_STROOPS),
      tx,
      passphrase
    );

    // Deterministic given a fixed per-operation base fee and the protocol's own 100-operation
    // ceiling, but checked explicitly anyway: the documented mitigation is a fee cap, not an
    // inference from how the fee happens to be computed today.
    if (BigInt(feeBumpTx.fee) > BigInt(MAX_FEE_BUMP_STROOPS)) {
      fail("fee_bump_exceeds_cap", "The sponsored fee exceeds what this endpoint will cover", 400);
    }

    feeBumpTx.sign(feeAccount);
    return { transaction: feeBumpTx.toEnvelope().toXDR("base64") };
  }
}
