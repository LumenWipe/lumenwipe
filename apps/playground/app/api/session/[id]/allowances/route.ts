import { NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { sdkAllowanceApi } from "@/lib/allowances";
import { loadSignerState } from "@/lib/horizon-submit";
import { sessionStore } from "@/lib/session-store";
import { handleAllowances } from "@/lib/route-handlers";

export const maxDuration = 60;

/** The recorded allowances the API lists for the demo; see `handleAllowances`. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleAllowances(id, {
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
