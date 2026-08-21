import { NextRequest, NextResponse } from "next/server";
import { LumenWipeClient } from "@lumenwipe/sdk";
import { loadSessionOrErrorResponse } from "@/lib/route-helpers";

export const maxDuration = 30;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionOrErrorResponse(id);
  if (session instanceof NextResponse) return session;

  const apiUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!apiUrl || !apiKey) {
    return NextResponse.json({ error: "Playground is not configured on this server." }, { status: 503 });
  }

  const client = new LumenWipeClient({ baseUrl: apiUrl, apiKey, network: "testnet" });

  try {
    const accountState = await client.getAccount(session.demoPublic);
    return NextResponse.json({
      demoPublic: session.demoPublic,
      accountState,
      completedMessSteps: session.completedMessSteps,
      demolishLog: session.demolishLog,
      demolishDone: session.demolishDone,
    });
  } catch {
    // The demo account no longer exists once the merge lands - that's success, not an error.
    return NextResponse.json({
      demoPublic: session.demoPublic,
      accountState: null,
      completedMessSteps: session.completedMessSteps,
      demolishLog: session.demolishLog,
      demolishDone: session.demolishDone,
    });
  }
}
