import { NextRequest } from "next/server";
import { getPlaygroundIssuerKeypair, getPlaygroundMmKeypair } from "@/lib/accounts";
import { handleBatchSdkSnippet } from "@/lib/batch-handlers";
import { sessionStore } from "@/lib/session-store";

export const maxDuration = 10;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBatchSdkSnippet(id, {
    store: sessionStore,
    publicAccounts: () => {
      const mm = getPlaygroundMmKeypair();
      const issuer = getPlaygroundIssuerKeypair();
      return mm && issuer ? { sink: mm.publicKey(), issuer: issuer.publicKey() } : null;
    },
  });
}
