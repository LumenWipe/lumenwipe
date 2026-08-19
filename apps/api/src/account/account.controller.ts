import { Controller, Get, HttpException, Logger, Param, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account-state";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import { fail } from "@/common/fail";

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
  @ApiResponse({ status: 200, description: "Aggregated account state." })
  @ApiResponse({ status: 400, description: "Invalid network or address." })
  @ApiResponse({ status: 404, description: "Account not found." })
  async account(@Param("network") network: string, @Param("address") address: string) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network", 400);
    if (!isValidGAddress(address)) {
      fail("invalid_address", "Invalid Stellar address", 400);
    }

    try {
      return await getAccountState(address, network);
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
        fail("account_unreadable", err.message, 422);
      }
      this.logger.error("account fetch failed", err instanceof Error ? err.stack : String(err));
      fail("account_read_failed", "Failed to fetch account data", 500);
    }
  }

  @Get("paths")
  @ApiOperation({ summary: "Find a conversion path from an asset to XLM." })
  @ApiQuery({ name: "fromAsset", description: "Asset to convert (e.g. CODE:ISSUER or 'native')." })
  @ApiQuery({ name: "amount", description: "Amount of the source asset." })
  @ApiResponse({ status: 200, description: "The conversion path (or null if none)." })
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
