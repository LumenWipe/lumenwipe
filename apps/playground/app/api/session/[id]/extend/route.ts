import { NextRequest } from "next/server";
import { sessionStore } from "@/lib/session-store";
import { handleExtend } from "@/lib/route-handlers";

export const maxDuration = 10;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleExtend(id, { store: sessionStore });
}
