import { expect, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { poolShareTrustlineKey, RPC_LEDGER_KEY_LIMIT } from "@/lib/stellar/live-ledger";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { readPoolShareSponsors, type RawLedgerReader } from "@/lib/stellar/pool-share-sponsors";

const OWNER = Keypair.random().publicKey();
const POOL_A = "d714bc2e56f74a4a4de2e81284a35b6fe09582f081bf785fc698310895c2d845";
const POOL_B = "68c2effe683511c8a4c57279651751e15d55d546f646fc12b7c54aa807966a0b";
// Recorded from testnet `getLedgerEntries` answers for a pool share trustline: a sponsored line's
// extension (v1, sponsoringId set) and an unsponsored one's (v0).
const SPONSORED_EXT = "AAAAAQAAAAEAAAAA16rLaINZLWQEqbRLD03NOScH2DSga/0IrLhCXHleXrwAAAAA";
const RECORDED_SPONSOR = "GDL2VS3IQNMS2ZAEVG2EWD2NZU4SOB6YGSQGX7IIVS4EEXDZLZPLYQNW";
const UNSPONSORED_EXT = "AAAAAA==";
// A v1 extension with no sponsoringId: a line that once had liabilities, not a sponsor.
const V1_NO_SPONSOR_EXT = xdr.LedgerEntryExt.v1(
  new xdr.LedgerEntryExtensionV1({ sponsoringId: null, ext: xdr.LedgerEntryExtensionV1Ext.v0() })
).toXDR("base64");

const keyOf = (poolId: string): string => poolShareTrustlineKey(OWNER, poolId).toXDR("base64");

function reader(answer: (keys: xdr.LedgerKey[]) => unknown): RawLedgerReader & { calls: number } {
  const server = {
    calls: 0,
    async _getLedgerEntries(...keys: xdr.LedgerKey[]) {
      server.calls += 1;
      return answer(keys);
    },
  };
  return server;
}

const entry = (poolId: string, extXdr?: string) => ({
  key: keyOf(poolId),
  xdr: "AAAAAQ==",
  lastModifiedLedgerSeq: 5836907,
  ...(extXdr !== undefined && { extXdr }),
});

test("readPoolShareSponsors › the sponsor of a sponsored line, as a G address, and null for an unsponsored one", async () => {
  const server = reader(() => ({
    latestLedger: 5836908,
    entries: [entry(POOL_A, SPONSORED_EXT), entry(POOL_B, UNSPONSORED_EXT)],
  }));
  const sponsors = await readPoolShareSponsors(server, OWNER, [POOL_A, POOL_B]);
  expect(sponsors).toEqual(
    new Map<string, string | null>([
      [POOL_A, RECORDED_SPONSOR],
      [POOL_B, null],
    ])
  );
});

test("readPoolShareSponsors › a v1 extension without a sponsoring id is unsponsored", async () => {
  const server = reader(() => ({ entries: [entry(POOL_A, V1_NO_SPONSOR_EXT)] }));
  expect(await readPoolShareSponsors(server, OWNER, [POOL_A])).toEqual(new Map([[POOL_A, null]]));
});

test("readPoolShareSponsors › asks for the owner's share trustline key in each pool", async () => {
  let asked: string[] = [];
  const server = reader((keys) => {
    asked = keys.map((k) => k.toXDR("base64"));
    return { entries: [entry(POOL_A, UNSPONSORED_EXT)] };
  });
  await readPoolShareSponsors(server, OWNER, [POOL_A]);
  expect(asked).toEqual([keyOf(POOL_A)]);
});

test("readPoolShareSponsors › a provider that sends no extXdr fails the read instead of reading unsponsored", async () => {
  const server = reader(() => ({ entries: [entry(POOL_A)] }));
  await expect(readPoolShareSponsors(server, OWNER, [POOL_A])).rejects.toBeInstanceOf(
    LiveReadError
  );
});

test("readPoolShareSponsors › every unusable answer fails the read", async () => {
  const answers: unknown[] = [
    // A line Horizon listed that the ledger does not hold.
    { entries: [entry(POOL_A, SPONSORED_EXT)] },
    { entries: [entry(POOL_A, "not xdr"), entry(POOL_B, UNSPONSORED_EXT)] },
    // A line nobody asked for.
    {
      entries: [entry(POOL_A, UNSPONSORED_EXT), { ...entry(POOL_B, UNSPONSORED_EXT), key: "AAAA" }],
    },
    { entries: [{ xdr: "AAAAAQ==", extXdr: SPONSORED_EXT }, entry(POOL_B, UNSPONSORED_EXT)] },
    { entries: ["nope"] },
    { entries: null },
    null,
  ];
  for (const answer of answers) {
    await expect(
      readPoolShareSponsors(
        reader(() => answer),
        OWNER,
        [POOL_A, POOL_B]
      )
    ).rejects.toBeInstanceOf(LiveReadError);
  }
});

test("readPoolShareSponsors › a failed request fails the read", async () => {
  const server = reader(() => {
    throw new Error("boom");
  });
  await expect(readPoolShareSponsors(server, OWNER, [POOL_A])).rejects.toBeInstanceOf(
    LiveReadError
  );
});

test("readPoolShareSponsors › more lines than one request holds are read in chunks", async () => {
  const pools = Array.from({ length: RPC_LEDGER_KEY_LIMIT + 1 }, (_, i) =>
    i.toString(16).padStart(64, "0")
  );
  const server = reader((keys) => ({
    entries: keys.map((k) => ({
      key: k.toXDR("base64"),
      xdr: "AAAAAQ==",
      extXdr: UNSPONSORED_EXT,
    })),
  }));
  const sponsors = await readPoolShareSponsors(server, OWNER, pools);
  expect(server.calls).toBe(2);
  expect(sponsors.size).toBe(pools.length);
});
