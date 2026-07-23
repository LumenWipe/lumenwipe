import { Controller, Get, HttpException, Param, Query } from "@nestjs/common";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account";
import { getLiveAccountState } from "@/lib/stellar/account-live";
import { needsLiveRescan } from "@/lib/stellar/scan-fallback";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { AccountNotFoundError } from "@/lib/utils/errors";

@Controller(":network")
export class AccountController {
  @Get("account/:address")
  async account(@Param("network") network: string, @Param("address") address: string) {
    if (!isValidNetwork(network)) throw new HttpException({ error: "Invalid network" }, 400);
    if (!isValidGAddress(address)) {
      throw new HttpException({ error: "Invalid Stellar address" }, 400);
    }

    try {
      let accountData = await getAccountState(address, network);

      // stellar.expert lags for freshly created accounts and never returns
      // manage-data entries. On any mismatch, fall back to the Horizon-based
      // live path which has zero indexing lag and full enumeration.
      if (needsLiveRescan(accountData)) {
        try {
          accountData = await getLiveAccountState(address, network);
        } catch {
          // Keep the SE-based result if the live path also fails.
        }
      }

      return accountData;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof AccountNotFoundError) {
        throw new HttpException({ error: err.message }, 404);
      }
      console.error("Account fetch error:", err);
      throw new HttpException({ error: "Failed to fetch account data" }, 500);
    }
  }

  @Get("paths")
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
      console.error("Path fetch error:", err);
      throw new HttpException({ error: "Failed to fetch conversion path" }, 500);
    }
  }
}
