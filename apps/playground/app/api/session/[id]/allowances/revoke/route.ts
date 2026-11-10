import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sdkAllowanceApi } from "@/lib/allowances";
import { loadSignerState } from "@/lib/horizon-submit";
import { sessionStore } from "@/lib/session-store";
import { handleRevokeAllowance } from "@/lib/route-handlers";

// One revoke: the API's build, a signer read and a confirmed submit. Below SESSION_LOCK_TTL_MS
// (lib/session-store.ts), so a request the platform kills frees the session.
export const maxDuration = 60;

/** Revokes one recorded allowance with the demo key; see `handleRevokeAllowance`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleRevokeAllowance(req, id, {
    store: sessionStore,
    api: () => ({
      apiUrl: process.env.LUMENWIPE_API_URL,
      apiKey: process.env.LUMENWIPE_API_KEY,
    }),
    decrypt: decryptSecret,
    allowanceApi: sdkAllowanceApi,
    signerState: loadSignerState,
  });
}
