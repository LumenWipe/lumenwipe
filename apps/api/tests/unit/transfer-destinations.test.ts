import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  validateTransferDestinations,
  type AccountReader,
} from "@/lib/close-api/transfer-destinations";
import type { AccountState, Trustline } from "@lumenwipe/types";

const SOURCE = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

function trustline(asset: string, balance: string, limit?: string): Trustline {
  const [code, issuer] = asset.split(":");
  return { asset, balance, authorized: true, issuer: issuer!, code: code!, limit };
}

function account(address: string, trustlines: Trustline[]): AccountState {
  return {
    address,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: address, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: trustlines.length,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines,
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
  };
}

/** Reader over a fixed set of accounts; anything else reads as not found. */
function readerFor(accounts: AccountState[]): AccountReader {
  const byAddress = new Map(accounts.map((a) => [a.address, a]));
  return async (address) => byAddress.get(address) ?? null;
}

test("a destination holding the trustline with room is accepted", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    readerFor([account(DESTINATION, [trustline(USDC, "5", "1000")])])
  );
  expect(problems).toEqual([]);
});

test("no transfer destinations means no reads and no problems", async () => {
  let reads = 0;
  const problems = await validateTransferDestinations({}, [], SOURCE, "testnet", async () => {
    reads++;
    return null;
  });
  expect(problems).toEqual([]);
  expect(reads).toBe(0);
});

// ─── Each failure mode independently ─────────────────────────────────────────

test("a destination account that does not exist is a blocker", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    readerFor([])
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]!.code).toBe("destination_missing");
});

test("a destination without the trustline is a blocker naming the alternatives", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    // Holds a different asset, so the account exists but cannot receive this one.
    readerFor([account(DESTINATION, [trustline(`EURC:${ISSUER}`, "1", "1000")])])
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]!.code).toBe("destination_lacks_trustline");
  // The tool cannot add the trustline itself - that needs the destination's signature - so the
  // message has to leave the user somewhere to go.
  expect(problems[0]!.message).toMatch(/Add the trustline from that account/i);
  expect(problems[0]!.message).toMatch(/convert|issuer/i);
});

test("a destination whose limit cannot absorb the balance is a blocker", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    // 950 held + 100 incoming exceeds the 1000 limit.
    readerFor([account(DESTINATION, [trustline(USDC, "950", "1000")])])
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]!.code).toBe("destination_limit_too_low");
});

test("filling the limit exactly is allowed - the ledger accepts balance == limit", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    readerFor([account(DESTINATION, [trustline(USDC, "900", "1000")])])
  );
  expect(problems).toEqual([]);
});

test("transferring to the account being closed is a blocker", async () => {
  const problems = await validateTransferDestinations(
    { [USDC]: SOURCE },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    readerFor([account(SOURCE, [trustline(USDC, "100", "1000")])])
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]!.code).toBe("destination_is_source");
});

// ─── Behaviour that is easy to get wrong ─────────────────────────────────────

test("an unknown limit does not block: absence of data is not evidence of no room", async () => {
  // The RPC reader never exposed `limit`. Defaulting a missing one to zero would turn a provider
  // change into a total, silent outage of the transfer path rather than a real constraint.
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION },
    [trustline(USDC, "100")],
    SOURCE,
    "testnet",
    readerFor([account(DESTINATION, [trustline(USDC, "5", undefined)])])
  );
  expect(problems).toEqual([]);
});

test("every failing destination is reported, not just the first", async () => {
  const second = Keypair.random().publicKey();
  const EURC = `EURC:${ISSUER}`;
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION, [EURC]: second },
    [trustline(USDC, "100"), trustline(EURC, "50")],
    SOURCE,
    "testnet",
    readerFor([account(DESTINATION, [])])
  );
  // One lacks the trustline, the other does not exist. Reporting only the first would make the
  // user rebuild once per broken destination to discover them all.
  expect(problems).toHaveLength(2);
  expect(problems.map((p) => p.code).sort()).toEqual([
    "destination_lacks_trustline",
    "destination_missing",
  ]);
});

test("the same destination for several assets is read once", async () => {
  const EURC = `EURC:${ISSUER}`;
  const reads: string[] = [];
  const target = account(DESTINATION, [trustline(USDC, "0", "1000"), trustline(EURC, "0", "1000")]);
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION, [EURC]: DESTINATION },
    [trustline(USDC, "100"), trustline(EURC, "50")],
    SOURCE,
    "testnet",
    async (address) => {
      reads.push(address);
      return address === DESTINATION ? target : null;
    }
  );
  expect(problems).toEqual([]);
  expect(reads).toEqual([DESTINATION]);
});

test("each asset is validated against its own destination, not a shared one", async () => {
  const second = Keypair.random().publicKey();
  const EURC = `EURC:${ISSUER}`;
  const problems = await validateTransferDestinations(
    { [USDC]: DESTINATION, [EURC]: second },
    [trustline(USDC, "100"), trustline(EURC, "50")],
    SOURCE,
    "testnet",
    readerFor([
      account(DESTINATION, [trustline(USDC, "0", "1000")]),
      // Trusts USDC but not EURC: a validator keyed by address rather than by asset would pass
      // this, and the close would fail on-chain.
      account(second, [trustline(USDC, "0", "1000")]),
    ])
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]!.asset).toBe(EURC);
  expect(problems[0]!.code).toBe("destination_lacks_trustline");
});
