import type { NextResponse } from "next/server";
import { handleScenarios } from "@/lib/route-handlers";
import { unavailableScenarios } from "@/lib/scenario-availability";

// Read on every request, so changing PLAYGROUND_DISABLED_SCENARIOS needs no code change, and the
// exchange close follows the API's own mediator check.
export const dynamic = "force-dynamic";

export function GET(): Promise<NextResponse> {
  return handleScenarios({ unavailable: unavailableScenarios });
}
