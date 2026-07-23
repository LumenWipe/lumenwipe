import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { submitAndWait, InvalidSignatureError } from "@/lib/stellar/submit";
import { TxTimeoutError } from "@/lib/utils/errors";

interface SubmitBody {
  signedXdr?: unknown;
}

function err(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
): Promise<NextResponse> {
  const { network } = await params;
  if (!isValidNetwork(network)) return err("invalid_network", "Invalid network.", 400);

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return err("invalid_body", "Request body must be valid JSON.", 400);
  }

  const { signedXdr } = body;
  if (typeof signedXdr !== "string" || signedXdr.length === 0) {
    return err("invalid_signed_xdr", "A signed transaction envelope (signedXdr) is required.", 400);
  }

  try {
    const result = await submitAndWait(signedXdr, network);
    return NextResponse.json(
      { status: "success", hash: result.txHash, ledger: result.ledger },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof InvalidSignatureError) {
      return err("invalid_signature", "The transaction is missing a valid signature.", 400);
    }
    if (e instanceof TxTimeoutError) {
      return err("confirmation_timeout", "The transaction did not confirm in time.", 504);
    }
    // Malformed XDR throws a generic decode error before reaching the network.
    if (e instanceof Error && /xdr|envelope|decode/i.test(e.message)) {
      return err("invalid_signed_xdr", "The transaction envelope could not be decoded.", 400);
    }
    console.error("submit error:", e);
    return err("submit_failed", "Failed to submit the transaction.", 502);
  }
}
