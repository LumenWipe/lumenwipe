import type { NextRequest } from "next/server";
import { relayIntegrator } from "@/lib/integrator/relay";

export function GET(req: NextRequest) {
  return relayIntegrator(req, "keys", "GET");
}

export function POST(req: NextRequest) {
  return relayIntegrator(req, "keys", "POST");
}
