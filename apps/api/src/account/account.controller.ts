import { Controller, Get, HttpException, Logger, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account-state";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { AccountNotFoundError } from "@/lib/utils/errors";

@ApiTags("account")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiResponse({ status: 401, description: "Missing or invalid API key." })
@ApiResponse({ status: 429, description: "Rate limit exceeded for this key." })
@Controller(":network")
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  @Get("account/:address")
  @ApiOperation({ summary: "Read full on-chain account state (balances, trustlines, offers, signers)." })
  @ApiParam({ name: "address", description: "Stellar account (G...)." })
  @ApiResponse({ status: 200, description: "Aggregated account state." })
  @ApiResponse({ status: 400, description: "Invalid network or address." })
  @ApiResponse({ status: 404, description: "Account not found." })
  async account(@Param("network") network: string, @Param("address") address: string) {
    if (!isValidNetwork(network)) throw new HttpException({ error: "Invalid network" }, 400);
    if (!isValidGAddress(address)) {
      throw new HttpException({ error: "Invalid Stellar address" }, 400);
    }

    try {
      return await getAccountState(address, network);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof AccountNotFoundError) {
        throw new HttpException({ error: err.message }, 404);
      }
      this.logger.error("account fetch failed", err instanceof Error ? err.stack : String(err));
      throw new HttpException({ error: "Failed to fetch account data" }, 500);
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
    if (!isValidNetwork(network)) throw new HttpException({ error: "Invalid network" }, 400);
    if (!fromAsset || !amount) {
      throw new HttpException({ error: "Missing fromAsset or amount" }, 400);
    }

    try {
      const path = await fetchConversionPath(fromAsset, amount, network);
      return { path };
    } catch (err) {
      this.logger.error("path fetch failed", err instanceof Error ? err.stack : String(err));
      throw new HttpException({ error: "Failed to fetch conversion path" }, 500);
    }
  }
}
