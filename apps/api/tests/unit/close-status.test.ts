import { describe, expect, test } from "bun:test";
import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import { readCloseStatus, type LastOperationReader } from "@/lib/close-api/close-status";
import { LiveReadError } from "@/lib/stellar/live-trustline";

const SOURCE = Keypair.random().publicKey();

const reader = (entries: unknown) =>
  ({ getLedgerEntries: async () => ({ entries }) }) as unknown as Pick<
    rpc.Server,
    "getLedgerEntries"
  >;

const never: LastOperationReader = () => {
  throw new Error("history must not be read for an account on the ledger");
};

describe("readCloseStatus", () => {
  test("an absent account whose last operation is a merge is closed", async () => {
    const status = await readCloseStatus(
      reader([]),
      async () => ({ type: "account_merge" }),
      SOURCE
    );
    expect(status).toEqual({ source: SOURCE, phase: "closed" });
  });

  test("an absent account with no history is unknown", async () => {
    expect((await readCloseStatus(reader([]), async () => null, SOURCE)).phase).toBe("unknown");
  });

  test("an absent account whose last operation is not a merge is unknown", async () => {
    const status = await readCloseStatus(reader([]), async () => ({ type: "payment" }), SOURCE);
    expect(status.phase).toBe("unknown");
  });

  test("sponsorships count as remaining work", async () => {
    const ext = {
      type: "v1",
      v1: { ext: { type: "v2", v2: { numSponsoring: 2, numSponsored: 1 } } },
    } as unknown as xdr.AccountEntry["ext"];
    const status = await readCloseStatus(
      reader([{ val: { type: "account", account: { numSubEntries: 0, ext } } }]),
      never,
      SOURCE
    );
    expect(status).toEqual({
      source: SOURCE,
      phase: "open",
      remaining: { subentries: 0, sponsoring: 2, sponsored: 1 },
    });
  });

  test("a shape the ledger read should not return is a failed read", async () => {
    await expect(readCloseStatus(reader(null), never, SOURCE)).rejects.toBeInstanceOf(
      LiveReadError
    );
    await expect(
      readCloseStatus(reader([{ val: { type: "trustline" } }]), never, SOURCE)
    ).rejects.toBeInstanceOf(LiveReadError);
  });
});
