import { NextResponse } from "next/server";
import { fetchStatsFeed, fetchStatsTotals } from "@/lib/api/stats-upstream";
import { toFeedData } from "@/lib/stats";

export const revalidate = 30;

export async function GET() {
  try {
    const [mainnet, testnet] = await Promise.all([
      fetchStatsFeed("mainnet", revalidate),
      fetchStatsTotals("testnet", revalidate),
    ]);
    return NextResponse.json(toFeedData(mainnet, testnet));
  } catch (err) {
    console.error("Failed to read the stats feed from the API:", err);
    return NextResponse.json({ error: "feed_unavailable" }, { status: 503 });
  }
}
