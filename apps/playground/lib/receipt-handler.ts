import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { RECEIPTS_PER_DAY_PER_IP, type RateLimit } from "./rate-limit";
import type { TransactionRecord } from "./horizon-submit";
import { readReceipt } from "./receipt";

const TX_HASH = /^[0-9a-f]{64}$/;

export interface ReceiptRouteDeps {
  rateLimit: RateLimit;
  /** The testnet transaction by its hash; null while Horizon does not know it. */
  load: (hash: string) => Promise<TransactionRecord | null>;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One close transaction's receipt for one account: public testnet data, read by hash, so it takes
 * no session and hands back nothing that grants access. A confirmed result never changes, so a
 * read receipt may be cached for good; anything else is retried.
 */
export async function handleReceipt(
  req: NextRequest,
  deps: ReceiptRouteDeps
): Promise<NextResponse> {
  const limited = await deps.rateLimit(req, "receipt", RECEIPTS_PER_DAY_PER_IP);
  if (limited) return limited;

  const account = req.nextUrl.searchParams.get("account") ?? "";
  const hash = req.nextUrl.searchParams.get("hash") ?? "";
  if (!StrKey.isValidEd25519PublicKey(account) || !TX_HASH.test(hash)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  let record: TransactionRecord | null;
  try {
    record = await deps.load(hash);
  } catch (err) {
    console.error("[playground] receipt read failed", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ hash, status: "unavailable" }, { headers: NO_STORE });
  }
  if (!record) return NextResponse.json({ hash, status: "pending" }, { headers: NO_STORE });

  const receipt = readReceipt(record, hash, account);
  const headers =
    receipt.status === "read" || receipt.status === "failed"
      ? { "Cache-Control": "public, max-age=31536000, immutable" }
      : NO_STORE;
  return NextResponse.json(receipt, { headers });
}
