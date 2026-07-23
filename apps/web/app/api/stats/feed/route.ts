import { NextResponse } from "next/server";
import { getRecentMerges, getDailyActivity, getStats } from "@/lib/kv";

export const revalidate = 30;

export async function GET() {
  try {
    const [recent, daily, totals] = await Promise.all([
      getRecentMerges("mainnet", 50),
      getDailyActivity("mainnet", 365),
      getStats(),
    ]);
    return NextResponse.json({ recent, daily, totals });
  } catch (err) {
    console.error("Failed to read feed from KV:", err);
    return NextResponse.json({ error: "feed_unavailable" }, { status: 503 });
  }
}
