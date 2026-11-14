import { NextRequest } from "next/server";
import { readClient } from "@/lib/api-clients";
import { sessionStore } from "@/lib/session-store";
import { handleState } from "@/lib/route-handlers";

// Two reads at the SDK's timeout and the wait between them (READ_RETRY_ROUTE_BUDGET_MS), under
// the session lock's TTL.
export const maxDuration = 125;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleState(id, {
    store: sessionStore,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    accountReader: (baseUrl, apiKey) => {
      const client = readClient(baseUrl, apiKey);
      return (publicKey) => client.getAccount(publicKey);
    },
  });
}
