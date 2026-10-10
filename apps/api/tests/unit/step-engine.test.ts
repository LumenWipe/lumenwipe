import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { fetchLiveTrustlineBalance } from "@/lib/stellar/step-engine";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { ledgerEntries } from "./fixtures/ledger-trustlines";
import { getRpcServer } from "@/lib/stellar/rpc";
import type { Trustline } from "@lumenwipe/types";

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

const LINE = (balance: bigint) => ({ [`${ACCOUNT}|USDC:${ISSUER}`]: { balance } });

function stubServer(getLedgerEntries: RpcServer["getLedgerEntries"]): RpcServer {
  return { getLedgerEntries } as unknown as RpcServer;
}

test("fetchLiveTrustlineBalance › reads the live balance from the ledger entry, in lumens", async () => {
  const server = stubServer(ledgerEntries(LINE(250000000n)) as RpcServer["getLedgerEntries"]);
  expect(await fetchLiveTrustlineBalance(TL, ACCOUNT, server)).toBe("25");
});

test("fetchLiveTrustlineBalance › a line the ledger confirms is gone reads as zero", async () => {
  const server = stubServer(ledgerEntries({}) as RpcServer["getLedgerEntries"]);
  expect(await fetchLiveTrustlineBalance(TL, ACCOUNT, server)).toBe("0");
});

test("fetchLiveTrustlineBalance › a failed read throws instead of returning the cached balance", async () => {
  const server = stubServer(() => Promise.reject(new Error("rpc down")));
  await expect(fetchLiveTrustlineBalance(TL, ACCOUNT, server)).rejects.toBeInstanceOf(
    LiveReadError
  );
});

test("fetchLiveTrustlineBalance › a malformed response throws instead of reading as absent", async () => {
  const server = stubServer((() => Promise.resolve({ latestLedger: 1 })) as never);
  await expect(fetchLiveTrustlineBalance(TL, ACCOUNT, server)).rejects.toBeInstanceOf(
    LiveReadError
  );
});
