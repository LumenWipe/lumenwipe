import { describe, expect, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { readAccountSequence } from "@/lib/stellar/account-sequence";
import { LiveReadError } from "@/lib/stellar/live-trustline";

const ACCOUNT = Keypair.random();

function accountEntry(seqNum: bigint): { val: xdr.LedgerEntryData } {
  return {
    val: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: ACCOUNT.xdrAccountId(),
        balance: 10_000_000n,
        seqNum,
        numSubEntries: 0,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: xdr.AccountEntryExt.v0(),
      })
    ),
  };
}

function serverReturning(entries: unknown) {
  return {
    getLedgerEntries: async () => {
      if (entries instanceof Error) throw entries;
      return { entries, latestLedger: 1 };
    },
  } as unknown as Parameters<typeof readAccountSequence>[0];
}

describe("readAccountSequence", () => {
  test("returns the account's sequence number", async () => {
    const server = serverReturning([accountEntry(42n)]);
    expect(await readAccountSequence(server, ACCOUNT.publicKey())).toBe(42n);
  });

  test("returns null when the account does not exist", async () => {
    expect(await readAccountSequence(serverReturning([]), ACCOUNT.publicKey())).toBeNull();
  });

  test("a failed or malformed read is an error, never a missing account", async () => {
    const read = (entries: unknown) =>
      readAccountSequence(serverReturning(entries), ACCOUNT.publicKey());
    await expect(read(new Error("rpc down"))).rejects.toBeInstanceOf(LiveReadError);
    await expect(read(undefined)).rejects.toBeInstanceOf(LiveReadError);
    await expect(read([{ val: { type: "trustline" } }])).rejects.toBeInstanceOf(LiveReadError);
  });
});
