import type { NextRequest } from "next/server";
import { relayIntegrator } from "@/lib/integrator/relay";

export function POST(req: NextRequest) {
  return relayIntegrator(req, "auth/session", "POST");
}
