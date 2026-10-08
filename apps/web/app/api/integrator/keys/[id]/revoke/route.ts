import type { NextRequest } from "next/server";
import { relayIntegrator } from "@/lib/integrator/relay";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relayIntegrator(req, `keys/${encodeURIComponent(id)}/revoke`, "POST");
}
