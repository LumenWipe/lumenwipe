import type { NextRequest } from "next/server";
import { relayIntegrator } from "@/lib/integrator/relay";
import { sessionResponse } from "@/lib/integrator/session-response";

/** Exchanges a contract account's signed challenge for a session held in an httpOnly cookie. */
export function POST(req: NextRequest) {
  return relayIntegrator(req, "auth/contract/testnet/session", "POST", {
    auth: "none",
    onSuccess: (payload, { bodyText }) => sessionResponse(payload, bodyText),
  });
}
