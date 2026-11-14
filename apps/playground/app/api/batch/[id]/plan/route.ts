import { NextRequest } from "next/server";
import { LumenWipeClient } from "@lumenwipe/sdk";
import { getPlaygroundMmKeypair } from "@/lib/accounts";
import { handleBatchPlan } from "@/lib/batch-handlers";
import { rateLimit } from "@/lib/rate-limit";
import { sessionStore } from "@/lib/session-store";

export const maxDuration = 30;

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
      const client = new LumenWipeClient({ baseUrl, apiKey, network: "testnet" });
      return (body) => client.batchPlan(body);
    },
  });
}
