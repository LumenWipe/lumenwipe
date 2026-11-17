/**
 * The Blend exit reads the account's own entries through blend-sdk's loaders, which open their
 * own `rpc.Server`; these pin that the loaders read an archived `Positions` or backstop
 * `UserBalance` as held, and an absent one as empty.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BackstopPoolUser, PoolUser, UserBalance, type Pool } from "@blend-capital/blend-sdk";
import { Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { blendSdkNetwork } from "@/lib/blend-sdk";
import { contractDataKey } from "@/lib/stellar/contract-data";
import { archivedAnswer, type EntryArchival } from "./fixtures/entry-archival";
import {
  contractDataEntry,
  i128Val,
  structVal,
  u32MapVal,
} from "./fixtures/testnet-direct-read-helpers";

const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const BACKSTOP = "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA";
const USER = Keypair.random().publicKey();
const NETWORK = blendSdkNetwork("testnet");
const STATES: EntryArchival[] = ["live", "evicted", "expired"];

const positionsEntry = contractDataEntry(
  POOL,
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Positions"), nativeToScVal(USER, { type: "address" })]),
  structVal({
    supply: u32MapVal([[0, 500_0000000n]]),
    collateral: u32MapVal([[0, 100_0000000n]]),
    liabilities: u32MapVal([[1, 250_0000000n]]),
  })
);

function backstopKey(): xdr.LedgerKey {
  return xdr.LedgerKey.fromXdr(
    UserBalance.ledgerKey(BACKSTOP, POOL, USER).toXDR("base64"),
    "base64"
  );
}

const backstopEntry = contractDataEntry(
  BACKSTOP,
  contractDataKey(backstopKey()).key,
  structVal({ shares: i128Val(5_0000000n), q4w: xdr.ScVal.scvVec([]) })
);

function serve(
  entries: Array<{ key: xdr.LedgerKey; val: xdr.LedgerEntryData }>,
  archival: EntryArchival
) {
  spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(async (...keys) => {
    const wanted = new Set(keys.map((k) => k.toXdr("base64")));
    return archivedAnswer(
      {
        latestLedger: 1,
        entries: entries
          .filter((e) => wanted.has(e.key.toXdr("base64")))
          .map((e) => ({ ...e, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 })),
      },
      archival
    );
  });
}

const noReserves = { reserves: new Map() } as unknown as Pool;

afterEach(() => {
  spyOn(rpc.Server.prototype, "getLedgerEntries").mockRestore();
});

describe("blend-sdk loaders read archived entries as held", () => {
  for (const archival of STATES) {
    test(`the pool user's Positions, ${archival}`, async () => {
      serve([positionsEntry], archival);
      const user = await PoolUser.load(NETWORK, POOL, noReserves, USER);
      expect(user.positions.supply.get(0)).toBe(500_0000000n);
      expect(user.positions.collateral.get(0)).toBe(100_0000000n);
      expect(user.positions.liabilities.get(1)).toBe(250_0000000n);
    });

    test(`the backstop UserBalance, ${archival}`, async () => {
      serve([backstopEntry], archival);
      const user = await BackstopPoolUser.load(NETWORK, BACKSTOP, POOL, USER, 0);
      expect(user.balance.shares).toBe(5_0000000n);
    });
  }

  test("an absent Positions or UserBalance entry loads as empty", async () => {
    serve([], "live");
    const user = await PoolUser.load(NETWORK, POOL, noReserves, USER);
    expect(user.positions.supply.size + user.positions.liabilities.size).toBe(0);
    const backstop = await BackstopPoolUser.load(NETWORK, BACKSTOP, POOL, USER, 0);
    expect(backstop.balance.shares).toBe(0n);
  });
});
