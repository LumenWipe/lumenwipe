import { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ network: string; address: string }> }
) {
  const { network, address } = await params;
  return proxy(() => getApiClient().getAccount(address, network as Network));
}
