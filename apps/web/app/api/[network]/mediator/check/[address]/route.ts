import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { lookupExchange } from "@/lib/exchange-registry";
import { getAccountState } from "@/lib/stellar/account";
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
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const exchange = lookupExchange(address);
  if (exchange) {
    return NextResponse.json({
      requiresMediator: exchange.requiresMediator,
      reason: `${exchange.name} does not support direct account merges.`,
      requiresMemo: exchange.requiresMemo,
      memoType: exchange.memoType,
      exchangeName: exchange.name,
    });
  }

  try {
    await getAccountState(address, network);
    return NextResponse.json({
      requiresMediator: false,
      reason: "Destination account exists and supports account merges.",
      requiresMemo: false,
      memoType: null,
      exchangeName: null,
    });
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json({
        requiresMediator: false,
        reason: "Destination account does not exist yet. Merging into it will create it.",
        requiresMemo: false,
        memoType: null,
        exchangeName: null,
      });
    }
    throw err;
  }
}
