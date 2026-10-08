import { NextResponse } from "next/server";
import { fetchStatsTotals } from "@/lib/api/stats-upstream";
import { toStatsResult } from "@/lib/stats";

export const revalidate = 5;

export async function GET() {
  try {
    const [testnet, mainnet] = await Promise.all([
      fetchStatsTotals("testnet", revalidate),
      fetchStatsTotals("mainnet", revalidate),
    ]);
    return NextResponse.json(toStatsResult(testnet, mainnet));
  } catch (err) {
    console.error("Failed to read stats from the API:", err);
    return NextResponse.json({ error: "stats_unavailable" }, { status: 503 });
  }
}
