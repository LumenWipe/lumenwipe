import { Body, Controller, Get, HttpException, Logger, Param, Post, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { StrKey } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { parseTokenContracts } from "@/lib/utils/token-contracts";
import { getAccountState } from "@/lib/stellar/account-state";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { discoverAllowances, defaultAllowancesDeps } from "@/lib/stellar/allowances";
import {
  buildRevokeAllowanceTransaction,
  RevokeAllowanceBlockedError,
} from "@/lib/stellar/revoke-allowance";
import { AccountNotFoundError, UnusableProviderResponseError } from "@/lib/utils/errors";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import { fail } from "@/common/fail";
import { PathResponseDto, RevokeAllowanceResponseDto } from "./dto/account-responses.dto";
import { AllowancesResultDto } from "./dto/allowance-responses.dto";
import { AccountStateDto } from "./dto/account-state-response.dto";

@ApiTags("account")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiResponse({ status: 401, description: "Missing or invalid API key." })
@ApiResponse({ status: 429, description: "Rate limit exceeded for this key." })
@Controller(":network")
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  @Get("account/:address")
  @ApiOperation({
    summary: "Read full on-chain account state (balances, trustlines, offers, signers).",
  })
  @ApiParam({ name: "address", description: "Stellar account (G...)." })
  @ApiResponse({
    status: 200,
    description: "Aggregated account state.",
    type: AccountStateDto,
  })
  @ApiResponse({ status: 400, description: "Invalid network or address." })
  @ApiQuery({
    name: "tokens",
    required: false,
    description:
      "Soroban token contracts (C..., comma-separated, at most 20) to check for a balance besides " +
      "what discovery finds.",
  })
  @ApiResponse({ status: 404, description: "Account not found." })
  async account(
    @Param("network") network: string,
    @Param("address") address: string,
    @Query("tokens") tokens?: string
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);
    if (!isValidGAddress(address)) {
      fail("invalid_address", "Invalid Stellar address", 400);
    }
    const manualTokenCandidates = parseTokenContracts(tokens);
    if (manualTokenCandidates === null) {
      fail(
        "invalid_tokens",
        "tokens must be up to 20 comma-separated Soroban contract addresses (C...).",
        400
      );
    }

    try {
      return await getAccountState(address, network, { manualTokenCandidates });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof AccountNotFoundError) {
        fail("account_not_found", err.message, 404);
      }
      // A collection too large to enumerate is a property of the account, not a fault of ours,
      // and its message explains what the caller is up against. Collapsing it into a generic
      // 500 would leave someone staring at "Failed to fetch account data" with no idea why
      // their account cannot be read - the opposite of the "blocker with an explanation"
      // invariant.
      if (err instanceof TruncatedCollectionError) {
        fail("account_too_large", err.message, 422);
      }
      // Same reasoning, pointed at the operator rather than the account holder: the configured
      // provider answered with a body no plan can be built from, and the message names the
      // fields it omitted. 502 because the fault is upstream of us, not in the request - and
      // whoever wired that provider in can act on it, which "Failed to fetch account data"
      // gives them no way to do.
      if (err instanceof UnusableProviderResponseError) {
        fail("provider_response_unusable", err.message, 502);
      }
      this.logger.error("account fetch failed", err instanceof Error ? err.stack : String(err));
      fail("account_read_failed", "Failed to fetch account data", 500);
    }
  }

  @Get("allowances/:address")
  @ApiOperation({
    summary:
      "Read every live SEP-41 allowance the account has granted (architecture.md §12). Read-only.",
  })
  @ApiParam({ name: "address", description: "Stellar account (G...)." })
  @ApiResponse({
    status: 200,
    description: "Live, non-zero allowances, best effort.",
    type: AllowancesResultDto,
  })
  @ApiResponse({ status: 400, description: "Invalid network or address." })
  async allowances(@Param("network") network: string, @Param("address") address: string) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);
    if (!isValidGAddress(address)) {
      fail("invalid_address", "Invalid Stellar address", 400);
    }

    try {
      return await discoverAllowances(address, network, defaultAllowancesDeps(network));
    } catch (err) {
      this.logger.error(
        "allowance discovery failed",
        err instanceof Error ? err.stack : String(err)
      );
      fail("allowances_read_failed", "Failed to read allowances", 500);
    }
  }

  @Post("allowances/revoke")
  @ApiOperation({
    summary:
      "Build a one-operation approve(owner, spender, 0, 0) transaction that revokes a SEP-41 " +
      "allowance (architecture.md §12). Unsigned - the caller signs and submits it.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["owner", "token", "spender"],
      properties: {
        owner: { type: "string", description: "The account whose allowance this is (G...)." },
        token: { type: "string", description: "The token contract the allowance is on (C...)." },
        spender: { type: "string", description: "The spender being revoked (C... or G...)." },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "The unsigned revocation transaction.",
    type: RevokeAllowanceResponseDto,
  })
  @ApiResponse({ status: 400, description: "Invalid network, owner, token, or spender." })
  @ApiResponse({ status: 422, description: "The revocation could not be built safely." })
  async revokeAllowance(
    @Param("network") network: string,
    @Body() body: { owner?: unknown; token?: unknown; spender?: unknown }
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);
    const owner = typeof body.owner === "string" ? body.owner : "";
    const token = typeof body.token === "string" ? body.token : "";
    const spender = typeof body.spender === "string" ? body.spender : "";
    if (!isValidGAddress(owner)) fail("invalid_owner", "Invalid owner address", 400);
    if (!StrKey.isValidContract(token)) fail("invalid_token", "Invalid token contract", 400);
    if (!StrKey.isValidContract(spender) && !StrKey.isValidEd25519PublicKey(spender)) {
      fail("invalid_spender", "Invalid spender address", 400);
    }

    try {
      const built = await buildRevokeAllowanceTransaction(owner, token, spender, network, {
        rpc: getRpcServer(network),
      });
      return { transaction: built.xdr };
    } catch (err) {
      if (err instanceof RevokeAllowanceBlockedError) {
        fail(err.code, err.message, 422);
      }
      // The SDK's own not-found error for a nonexistent owner account, thrown by getAccount()
      // before this function ever reaches its own error handling - surfaced by name rather than
      // as a generic failure, the same reasoning as account.controller.ts's own account() handler.
      if (err instanceof Error && err.message.startsWith("Account not found")) {
        fail("owner_not_found", "The owner account does not exist on this network", 404);
      }
      this.logger.error(
        "revoke allowance build failed",
        err instanceof Error ? err.stack : String(err)
      );
      fail("revoke_build_failed", "Failed to build the revocation transaction", 500);
    }
  }

  @Get("paths")
  @ApiOperation({ summary: "Find a conversion path from an asset to XLM." })
  @ApiQuery({ name: "fromAsset", description: "Asset to convert (e.g. CODE:ISSUER or 'native')." })
  @ApiQuery({ name: "amount", description: "Amount of the source asset." })
  @ApiResponse({
    status: 200,
    description: "The conversion path (or null if none).",
    type: PathResponseDto,
  })
  @ApiResponse({ status: 400, description: "Invalid network or missing query params." })
  async paths(
    @Param("network") network: string,
    @Query("fromAsset") fromAsset?: string,
    @Query("amount") amount?: string
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);
    if (!fromAsset || !amount) {
      fail("missing_parameters", "Missing fromAsset or amount", 400);
    }

    try {
      const path = await fetchConversionPath(fromAsset, amount, network);
      return { path };
    } catch (err) {
      this.logger.error("path fetch failed", err instanceof Error ? err.stack : String(err));
      fail("path_lookup_failed", "Failed to fetch conversion path", 500);
    }
  }
}
