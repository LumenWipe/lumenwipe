import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account";
import { getLiveAccountState } from "@/lib/stellar/account-live";
import { needsLiveRescan } from "@/lib/stellar/scan-fallback";
import { AccountNotFoundError } from "@/lib/utils/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ network: string; address: string }> }
) {
  const { network, address } = await params;

  if (!isValidNetwork(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }
  if (!isValidGAddress(address)) {
    return NextResponse.json({ error: "Invalid Stellar address" }, { status: 400 });
  }

  try {
    let accountData = await getAccountState(address, network);

    // stellar.expert lags for freshly created accounts and never returns
    // manage-data entries. On any mismatch, fall back to the Horizon-based
    // live path which has zero indexing lag and full enumeration; the
    // blocker only stands if the live scan confirms the mismatch.
    if (needsLiveRescan(accountData)) {
      try {
        accountData = await getLiveAccountState(address, network);
      } catch {
        // Keep the SE-based result if the live path also fails.
      }
    }

    return NextResponse.json(accountData, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("Account fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch account data" }, { status: 500 });
  }
}
