import { NextRequest } from "next/server";
import { LumenWipeClient } from "@lumenwipe/sdk";
import { sessionStore } from "@/lib/session-store";
import { handleState } from "@/lib/route-handlers";

export const maxDuration = 30;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleState(id, {
    store: sessionStore,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    accountReader: (baseUrl, apiKey) => {
      const client = new LumenWipeClient({ baseUrl, apiKey, network: "testnet" });
      return (publicKey) => client.getAccount(publicKey);
    },
  });
}
