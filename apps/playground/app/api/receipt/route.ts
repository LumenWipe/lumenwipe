import { NextRequest } from "next/server";
import { loadTransactionRecord } from "@/lib/horizon-submit";
import { handleReceipt } from "@/lib/receipt-handler";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 20;

// Testnet only: lib/horizon-submit.ts reads the testnet Horizon and lib/receipt.ts decodes with
// the testnet passphrase; no request value chooses the network.
export async function GET(req: NextRequest) {
  return handleReceipt(req, { rateLimit, load: loadTransactionRecord });
}
