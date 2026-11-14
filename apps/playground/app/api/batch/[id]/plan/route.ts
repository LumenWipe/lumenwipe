import { NextRequest } from "next/server";
import { readClient } from "@/lib/api-clients";
import { getPlaygroundMmKeypair } from "@/lib/accounts";
import { handleBatchPlan } from "@/lib/batch-handlers";
import { rateLimit } from "@/lib/rate-limit";
import { sessionStore } from "@/lib/session-store";

// Two reads at the SDK's timeout and the wait between them (READ_RETRY_ROUTE_BUDGET_MS), under
// the session lock's TTL.
export const maxDuration = 125;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBatchPlan(req, id, {
    store: sessionStore,
    rateLimit,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    sink: () => getPlaygroundMmKeypair()?.publicKey() ?? null,
    batchPlan: (baseUrl, apiKey) => {
      const client = readClient(baseUrl, apiKey);
      return (body) => client.batchPlan(body);
    },
  });
}
