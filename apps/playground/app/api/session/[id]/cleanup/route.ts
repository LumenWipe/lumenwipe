import { NextRequest } from "next/server";
import { Operation } from "@stellar/stellar-sdk";
import { decryptSecret } from "@/lib/crypto";
import { sessionStore } from "@/lib/session-store";
import { getPlaygroundMmKeypair } from "@/lib/accounts";
import { buildSignSubmit } from "@/lib/mess-builders";
import { handleCleanup } from "@/lib/route-handlers";

export const maxDuration = 60;

/** Recycles the ephemeral issuers and deletes the session; see `handleCleanup`. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCleanup(id, {
    store: sessionStore,
    mm: getPlaygroundMmKeypair,
    decrypt: decryptSecret,
    merge: (source, destination) =>
      buildSignSubmit(source, [Operation.accountMerge({ destination })]),
  });
}
