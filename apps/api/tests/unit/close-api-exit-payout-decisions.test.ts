/**
 * An asset a position's exit pays into the account is decided BEFORE the first round.
 *
 * The bug this covers, seen live on testnet: an account with an Aquarius XLM/AQUA LP and an
 * empty AQUA trustline planned cleanly and exited in round 1. The withdrawal paid 410 AQUA into
 * that trustline, and round 2 refused to build anything - "Resolve every pending decision before
 * requesting transactions" - for a disposition the caller had never been shown, from a screen
 * with no way to answer it. The close could not continue at all.
 */
import { test, expect } from "bun:test";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import type { AccountState, AquariusLpPosition, Trustline } from "@lumenwipe/types";
import { deriveDecisionPoints } from "@/lib/close-api/decisions";
import { assetsArrivingFromExits } from "@/lib/close-api/exit-payouts";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const AQUA = new Asset("AQUA", ISSUER);
const AQUA_SAC = AQUA.contractId(Networks.TESTNET);
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const POOL = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";

function trustline(code: string, balance: string, authorized = true): Trustline {
  return { asset: `${code}:${ISSUER}`, balance, authorized, issuer: ISSUER, code };
}

function aquariusLp(tokens: string[] | undefined): AquariusLpPosition {
  return {
    protocol: "aquarius",
    positionType: "lp",
    contractAddress: POOL,
    shareAmount: "1400729439",
    usdValue: null,
    ...(tokens ? { tokens } : {}),
  };
}

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "100.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
    ...overrides,
  };
}

function withLpPosition(tokens: string[] | undefined, trustlines: Trustline[]): AccountState {
  const account = makeAccount({ trustlines });
  return {
    ...account,
    defiPositions: {
      ...account.defiPositions,
      positions: [aquariusLp(tokens)],
    },
  };
}

test("an empty trustline an LP exit will pay into is decided before the first round", () => {
  const account = withLpPosition([XLM_SAC, AQUA_SAC], [trustline("AQUA", "0")]);

  const points = deriveDecisionPoints(account, { [`AQUA:${ISSUER}`]: true });

  expect(points.map((p) => p.id)).toEqual([`asset:AQUA-${ISSUER}`]);
  expect(points[0]!.required).toBe(true);
  expect(points[0]!.subject).toMatchObject({
    kind: "trustline",
    asset: `AQUA:${ISSUER}`,
    arrivesFromExit: true,
  });
});

test("the asset keeps the options its convertibility earns it", () => {
  const convertible = deriveDecisionPoints(
    withLpPosition([XLM_SAC, AQUA_SAC], [trustline("AQUA", "0")]),
    { [`AQUA:${ISSUER}`]: true }
  );
  expect(convertible[0]!.options.map((o) => o.id)).toEqual([
    "convert_to_xlm",
    "return_to_issuer",
    "transfer_to_account",
  ]);
  expect(convertible[0]!.default).toBe("convert_to_xlm");

  const stranded = deriveDecisionPoints(
    withLpPosition([XLM_SAC, AQUA_SAC], [trustline("AQUA", "0")]),
    { [`AQUA:${ISSUER}`]: false }
  );
  expect(stranded[0]!.options.map((o) => o.id)).toEqual([
    "return_to_issuer",
    "transfer_to_account",
  ]);
});

test("an asset that already holds a balance is not relabelled as arriving", () => {
  const account = withLpPosition([XLM_SAC, AQUA_SAC], [trustline("AQUA", "410.2511424")]);

  const points = deriveDecisionPoints(account, { [`AQUA:${ISSUER}`]: true });

  expect(points).toHaveLength(1);
  expect(points[0]!.subject).toMatchObject({ balance: "410.2511424", arrivesFromExit: false });
});

test("a trustline unrelated to any position is still skipped when empty", () => {
  const account = withLpPosition(
    [XLM_SAC, AQUA_SAC],
    [trustline("AQUA", "0"), trustline("USDC", "0")]
  );

  const points = deriveDecisionPoints(account, {});

  expect(points.map((p) => p.id)).toEqual([`asset:AQUA-${ISSUER}`]);
});

test("an unauthorized trustline cannot receive the payout and is not asked about", () => {
  const account = withLpPosition([XLM_SAC, AQUA_SAC], [trustline("AQUA", "0", false)]);

  expect(assetsArrivingFromExits(account).size).toBe(0);
  expect(deriveDecisionPoints(account, {})).toEqual([]);
});

test("a position whose token addresses were never read adds nothing", () => {
  const account = withLpPosition(undefined, [trustline("AQUA", "0")]);

  expect(assetsArrivingFromExits(account).size).toBe(0);
  expect(deriveDecisionPoints(account, {})).toEqual([]);
});

test("a Blend supply pays out its own asset", () => {
  const account = makeAccount({ trustlines: [trustline("USDC", "0")] });
  const withBlend: AccountState = {
    ...account,
    defiPositions: {
      ...account.defiPositions,
      positions: [
        {
          protocol: "blend",
          positionType: "supply",
          contractAddress: POOL,
          assetAddress: new Asset("USDC", ISSUER).contractId(Networks.TESTNET),
          bTokenAmount: "489171880",
          usdValue: null,
        },
      ],
    },
  };

  expect([...assetsArrivingFromExits(withBlend)]).toEqual([`USDC:${ISSUER}`]);
});

test("XLM arriving from an exit needs no disposition", () => {
  const account = withLpPosition([XLM_SAC, AQUA_SAC], []);

  expect(assetsArrivingFromExits(account).size).toBe(0);
  expect(deriveDecisionPoints(account, {})).toEqual([]);
});
