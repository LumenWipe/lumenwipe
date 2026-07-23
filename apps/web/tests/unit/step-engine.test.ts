import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { fetchLiveTrustlineBalance } from "@/lib/stellar/step-engine";
import { getRpcServer } from "@/lib/stellar/rpc";
import type { Trustline } from "@/types/account";

type RpcServer = ReturnType<typeof getRpcServer>;

const ACCOUNT = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

const TL: Trustline = {
  asset: `USDC:${ISSUER}`,
  balance: "12.5000000",
  limit: "922337203685.4775807",
  authorized: true,
  issuer: ISSUER,
  code: "USDC",
};

function stubServer(getAssetBalance: () => Promise<unknown>): RpcServer {
  return { getAssetBalance } as unknown as RpcServer;
}

test("fetchLiveTrustlineBalance › live balance via getAssetBalance, in lumens", async () => {
  const server = stubServer(() =>
    Promise.resolve({
      latestLedger: 123,
      balanceEntry: { amount: "250000000", authorized: true, clawback: false },
    })
  );
  expect(await fetchLiveTrustlineBalance(TL, ACCOUNT, server)).toBe("25");
});

test("fetchLiveTrustlineBalance › missing trustline (rejection) → cached balance", async () => {
  const server = stubServer(() => Promise.reject(new Error("Trustline not found")));
  expect(await fetchLiveTrustlineBalance(TL, ACCOUNT, server)).toBe("12.5000000");
});

test("fetchLiveTrustlineBalance › response without balanceEntry → cached balance", async () => {
  const server = stubServer(() => Promise.resolve({ latestLedger: 123 }));
  expect(await fetchLiveTrustlineBalance(TL, ACCOUNT, server)).toBe("12.5000000");
});
