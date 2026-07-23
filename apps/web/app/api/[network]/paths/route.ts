import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { fetchConversionPath } from "@/lib/se-api/paths";

export async function GET(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;
  if (!isValidNetwork(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }

  const fromAsset = req.nextUrl.searchParams.get("fromAsset");
  const amount = req.nextUrl.searchParams.get("amount");

  if (!fromAsset || !amount) {
    return NextResponse.json({ error: "Missing fromAsset or amount" }, { status: 400 });
  }

  try {
    const path = await fetchConversionPath(fromAsset, amount, network);
    return NextResponse.json({ path });
  } catch (err) {
    console.error("Path fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch conversion path" }, { status: 500 });
  }
}
