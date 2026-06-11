import { NextResponse } from "next/server";
import { getStats } from "@/lib/kv";

// Short revalidation keeps counters near real-time without hammering KV
// on every request.
export const revalidate = 5;

export async function GET() {
  try {
    const stats = await getStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("Failed to read stats from KV:", err);
    return NextResponse.json({ error: "stats_unavailable" }, { status: 503 });
  }
}
