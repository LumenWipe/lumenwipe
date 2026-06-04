import { NextResponse } from "next/server";
import { getRpcServer } from "@/lib/stellar/rpc";

async function pingRpc(network: "mainnet" | "testnet"): Promise<"ok" | "error"> {
  try {
    const server = getRpcServer(network);
    await server.getLatestLedger();
    return "ok";
  } catch {
    return "error";
  }
}

async function pingSeApi(): Promise<"ok" | "error"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://api.stellar.expert/explorer/public/asset?limit=1", {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

export async function GET() {
  const [rpcMainnet, rpcTestnet, seApi] = await Promise.all([
    pingRpc("mainnet"),
    pingRpc("testnet"),
    pingSeApi(),
  ]);

  const allOk = rpcMainnet === "ok" && rpcTestnet === "ok" && seApi === "ok";

  return NextResponse.json({ rpcMainnet, rpcTestnet, seApi }, { status: allOk ? 200 : 503 });
}
