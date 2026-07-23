import { NextRequest, NextResponse } from "next/server";
import { loadSession } from "@/lib/playground/session-server";
import { getLiveAccountState } from "@/lib/stellar/account-live";
import { AccountNotFoundError } from "@/lib/utils/errors";

export const maxDuration = 30;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  try {
    const accountState = await getLiveAccountState(session.demoPublic);
    return NextResponse.json({ demoPublic: session.demoPublic, accountState });
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      // The demo account no longer exists on the ledger: it has been merged.
      return NextResponse.json({ demoPublic: session.demoPublic, accountState: null });
    }
    console.error(`[playground] state fetch failed for session ${id}:`, err);
    return NextResponse.json({ error: "state_unavailable" }, { status: 502 });
  }
}
