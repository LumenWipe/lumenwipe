import { test, expect } from "bun:test";
import { Asset, Keypair, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { getTrustlineEntry } from "@/lib/stellar/rpc";

const ACCOUNT = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = new Asset("USDC", ISSUER);

function makeTrustlineEntry(balance: string, limit: string, flags: number): xdr.TrustLineEntry {
  return new xdr.TrustLineEntry({
    accountId: Keypair.fromPublicKey(ACCOUNT).xdrAccountId(),
    asset: USDC.toTrustLineXDRObject(),
    balance: xdr.Int64.fromString(balance),
    limit: xdr.Int64.fromString(limit),
    flags,
    ext: xdr.TrustLineEntryExt.fromXDR(Buffer.alloc(4)),
  });
}

function fakeServer(entries: xdr.TrustLineEntry[]): Pick<rpc.Server, "getLedgerEntries"> {
  return {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) =>
      ({
        latestLedger: 1,
        entries: entries.map((e) => ({
          key: keys[0],
          val: xdr.LedgerEntryData.trustline(e),
          lastModifiedLedgerSeq: 1,
        })),
      }) as Awaited<ReturnType<rpc.Server["getLedgerEntries"]>>,
  };
}

test("returns the parsed trustline entry when it exists on the ledger", async () => {
  const server = fakeServer([makeTrustlineEntry("50000000", "9223372036854775807", 1)]);
  const tl = await getTrustlineEntry(server, ACCOUNT, USDC);

  expect(tl).not.toBeNull();
  expect(BigInt(tl!.balance().toString())).toBe(BigInt(50000000));
  expect(BigInt(tl!.limit().toString())).toBe(BigInt("9223372036854775807"));
  expect(tl!.flags() & 1).toBe(1);
});

test("returns null when the trustline no longer exists", async () => {
  const server = fakeServer([]);
  const tl = await getTrustlineEntry(server, ACCOUNT, USDC);
  expect(tl).toBeNull();
});

test("builds a trustline LedgerKey for the requested account and asset", async () => {
  let captured: xdr.LedgerKey | undefined;
  const server: Pick<rpc.Server, "getLedgerEntries"> = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      captured = keys[0];
      return { latestLedger: 1, entries: [] } as unknown as Awaited<
        ReturnType<rpc.Server["getLedgerEntries"]>
      >;
    },
  };
  await getTrustlineEntry(server, ACCOUNT, USDC);

  expect(captured).toBeDefined();
  const tlKey = captured!.trustLine() as xdr.LedgerKeyTrustLine;
  expect(tlKey.accountId().toXDR("base64")).toBe(
    Keypair.fromPublicKey(ACCOUNT).xdrAccountId().toXDR("base64")
  );
  expect(tlKey.asset().toXDR("base64")).toBe(USDC.toTrustLineXDRObject().toXDR("base64"));
});
