import { NextRequest } from "next/server";
import { handleExtendBatch } from "@/lib/batch-handlers";
import { sessionStore } from "@/lib/session-store";

export const maxDuration = 10;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleExtendBatch(id, { store: sessionStore });
}
