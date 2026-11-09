import { NextRequest, NextResponse } from "next/server";
import { LumenWipeClient } from "@lumenwipe/sdk";
import {
  actionResponse,
  loadSessionOrErrorResponse,
  notConfiguredResponse,
} from "@/lib/route-helpers";
import { readSessionState } from "@/lib/session-actions";

export const maxDuration = 30;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionOrErrorResponse(id);
  if (session instanceof NextResponse) return session;

  const apiUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!apiUrl || !apiKey) return notConfiguredResponse();

  const client = new LumenWipeClient({ baseUrl: apiUrl, apiKey, network: "testnet" });
  return actionResponse(
    await readSessionState(session, { getAccount: (publicKey) => client.getAccount(publicKey) })
  );
}
