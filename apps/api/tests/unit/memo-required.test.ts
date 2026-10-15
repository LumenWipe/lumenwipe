import { describe, expect, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { MEMO_REQUIRED_DATA_NAME, readMemoRequired } from "@/lib/stellar/memo-required";
import { LiveReadError } from "@/lib/stellar/live-trustline";

const ACCOUNT = Keypair.random();

function dataEntry(value: string): { val: xdr.LedgerEntryData } {
  return {
    val: xdr.LedgerEntryData.data(
      new xdr.DataEntry({
        accountId: ACCOUNT.xdrAccountId(),
        dataName: MEMO_REQUIRED_DATA_NAME,
        dataValue: Buffer.from(value),
        ext: xdr.DataEntryExt.v0(),
      })
    ),
  };
}

function serverReturning(entries: unknown, keys: xdr.LedgerKey[] = []) {
  return {
    getLedgerEntries: async (...requested: xdr.LedgerKey[]) => {
      keys.push(...requested);
      if (entries instanceof Error) throw entries;
      return { entries, latestLedger: 1 };
    },
  } as unknown as Parameters<typeof readMemoRequired>[0];
}

describe("readMemoRequired", () => {
  test("reads the account's config.memo_required data entry", async () => {
    const keys: xdr.LedgerKey[] = [];
    await readMemoRequired(serverReturning([], keys), ACCOUNT.publicKey());
    expect(keys).toHaveLength(1);
    expect(keys[0]!.type).toBe("data");
    expect(
      keys[0]!.toXDR("base64") ===
        xdr.LedgerKey.data(
          new xdr.LedgerKeyData({
            accountId: ACCOUNT.xdrAccountId(),
            dataName: "config.memo_required",
          })
        ).toXDR("base64")
    ).toBe(true);
  });

  test("an entry set to 1 requires a memo", async () => {
    expect(await readMemoRequired(serverReturning([dataEntry("1")]), ACCOUNT.publicKey())).toBe(
      true
    );
  });

  test("an absent entry or any other value requires none", async () => {
    expect(await readMemoRequired(serverReturning([]), ACCOUNT.publicKey())).toBe(false);
    expect(await readMemoRequired(serverReturning([dataEntry("0")]), ACCOUNT.publicKey())).toBe(
      false
    );
  });

  test("a failed or malformed read is an error, never a no", async () => {
    const read = (entries: unknown) =>
      readMemoRequired(serverReturning(entries), ACCOUNT.publicKey());
    await expect(read(new Error("rpc down"))).rejects.toBeInstanceOf(LiveReadError);
    await expect(read(undefined)).rejects.toBeInstanceOf(LiveReadError);
    const notData = { val: { type: "account" } };
    await expect(read([notData])).rejects.toBeInstanceOf(LiveReadError);
  });
});
