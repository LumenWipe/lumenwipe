import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { assetOutcomes, type AssetOutcomeInput } from "@/lib/plan/asset-outcomes";
import { expectedReceive, withFeeStroops } from "@/lib/plan/expected-receive";
import { classicFloorFromQuote } from "@/lib/api/close-decisions";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import type { ClaimableBalance, Trustline } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER_A = Keypair.random().publicKey();
const ISSUER_B = Keypair.random().publicKey();
const FRIEND = Keypair.random().publicKey();
const TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";

function trustline(code: string, issuer: string, balance: string): Trustline {
  return {
    asset: `${code}:${issuer}`,
    code,
    issuer,
    balance,
    authorized: true,
    authorization: "authorized",
    clawbackEnabled: false,
  } as Trustline;
}

function claimable(id: string, asset: string, amount: string): ClaimableBalance {
  return {
    id,
    asset,
    amount,
    claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
    sponsor: null,
  } as ClaimableBalance;
}

const USDC_A = `USDC:${ISSUER_A}`;
const USDC_B = `USDC:${ISSUER_B}`;
const EURC = `EURC:${ISSUER_A}`;
const FOO = `FOO:${ISSUER_B}`;
const CLASSIC_QUOTE = { estimatedReceive: "21000000", minAmountOut: "20000000" };

function input(): AssetOutcomeInput {
  return {
    account: {
      trustlines: [
        trustline("USDC", ISSUER_A, "5.0000000"),
        trustline("USDC", ISSUER_B, "2.5000000"),
        trustline("EURC", ISSUER_A, "3.0000000"),
        trustline("FOO", ISSUER_B, "7.0000000"),
        trustline("ZERO", ISSUER_A, "0.0000000"),
      ],
      claimableBalances: [
        claimable("cb-forfeit", USDC_A, "1.0000000"),
        claimable("cb-native", "native", "4.0000000"),
      ],
      sorobanTokens: {
        tokens: [
          {
            contract: TOKEN,
            balance: "10000000",
            symbol: "TKN",
            decimals: 7,
            sources: ["explorer"],
          },
        ],
        unreadable: [],
        coverage: [],
        eventsScanned: null,
        warnings: [],
      },
    },
    dispositions: {
      [USDC_A]: "convert",
      [USDC_B]: "convert",
      [EURC]: "transfer",
      [FOO]: "issuer",
      [TOKEN]: "convert",
    },
    transferDestinations: { [EURC]: FRIEND },
    tokenConversionFloors: {
      [TOKEN]: { minAmountOut: "30000000", amountOut: "31000000", provider: "soroswap" },
    },
    classicConversionFloors: {
      [USDC_A]: { minAmountOut: classicFloorFromQuote(CLASSIC_QUOTE.minAmountOut) },
    },
    claimSelections: { "cb-forfeit": "forfeit", "cb-native": "claim" },
  };
}

const byKey = (key: string) => assetOutcomes(input()).find((r) => r.key === key)!;

test("one row per asset, token and claimable balance, and none for an empty trustline", () => {
  expect(assetOutcomes(input()).map((r) => r.key)).toEqual([
    USDC_A,
    USDC_B,
    EURC,
    FOO,
    TOKEN,
    "cb-forfeit",
    "cb-native",
  ]);
});

test("a swap carries the floor the plan quoted, and an unquoted one carries none", () => {
  expect(byKey(USDC_A)).toMatchObject({
    action: "convert",
    amount: "5",
    minimumStroops: classicFloorFromQuote("20000000"),
    givenUp: false,
  });
  expect(byKey(USDC_B)).toMatchObject({ action: "convert", minimumStroops: null });
  // The token's floor, never its quote.
  expect(byKey(TOKEN).minimumStroops).toBe("30000000");
});

test("a transfer names its full destination", () => {
  expect(byKey(EURC)).toMatchObject({ action: "transfer", destination: FRIEND, givenUp: false });
});

test("a return to issuer and a forfeited claim are given up; a claimed XLM balance adds", () => {
  expect(byKey(FOO)).toMatchObject({ action: "issuer", amount: "7", givenUp: true });
  expect(byKey("cb-forfeit")).toMatchObject({ action: "forfeit", amount: "1", givenUp: true });
  expect(byKey("cb-native")).toMatchObject({
    action: "claim",
    claimedStroops: "40000000",
    givenUp: false,
  });
});

test("two assets with one code keep their own issuers", () => {
  expect(byKey(USDC_A).issuer).toBe(ISSUER_A);
  expect(byKey(USDC_B).issuer).toBe(ISSUER_B);
});

test("the rows add up to the net estimate's lines, in stroops, with swaps at their minimum", () => {
  const conversions: AssetConvertibility[] = [
    {
      asset: USDC_A,
      code: "USDC",
      issuer: ISSUER_A,
      balance: "5",
      convertible: true,
      quote: CLASSIC_QUOTE,
    },
    { asset: USDC_B, code: "USDC", issuer: ISSUER_B, balance: "2.5", convertible: true },
    {
      asset: TOKEN,
      code: "TKN",
      balance: "1",
      convertible: true,
      token: {
        contract: TOKEN,
        symbol: "TKN",
        decimals: 7,
        rawBalance: "10000000",
        arrivesFromExit: false,
        quote: {
          amountOut: "31000000",
          minAmountOut: "30000000",
          platform: "router",
          route: [],
          provider: "soroswap",
          priceImpactBps: 10,
          flags: [],
        },
      },
    },
  ];
  const plan = expectedReceive({
    account: {
      nativeBalanceLumens: "50.0000000",
      numSubEntries: 6,
      numSponsoring: 0,
      defiPositions: emptyDefiPositionsResult(SOURCE),
    },
    planFeeStroops: "700",
    relayForwardUncounted: false,
    conversions,
    dispositions: input().dispositions,
    claims: [
      {
        balanceId: "cb-native",
        asset: "native",
        code: "XLM",
        amount: "4.0000000",
        currentlyClaimable: true,
        predicate: { type: "unconditional" },
        offered: ["claim", "forfeit"],
        unclaimableNote: null,
      },
    ],
    claimSelections: input().claimSelections,
  });
  const review = withFeeStroops(plan, "900");
  const rows = assetOutcomes(input());

  const swaps = rows.reduce((s, r) => s + BigInt(r.minimumStroops ?? "0"), BigInt(0));
  const claims = rows.reduce((s, r) => s + BigInt(r.claimedStroops ?? "0"), BigInt(0));
  expect(swaps.toString()).toBe(review.swapStroops);
  expect(claims.toString()).toBe(review.claimStroops);
  expect(BigInt(review.balanceStroops) - BigInt(review.feeStroops) + swaps + claims).toBe(
    BigInt(review.totalStroops)
  );
  // A swap counts its floor: counting the token's quote instead would add 1 XLM.
  expect(swaps).toBe(BigInt(classicFloorFromQuote("20000000")) + BigInt(30000000));
});

test("every recorded answer has a row, even for an asset the account read does not list", () => {
  const ARRIVING = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const GONE = `GONE:${ISSUER_B}`;
  const base = input();
  const withExtra: AssetOutcomeInput = {
    ...base,
    dispositions: { ...base.dispositions, [ARRIVING]: "convert", [GONE]: "transfer" },
    transferDestinations: { ...base.transferDestinations, [GONE]: FRIEND },
  };
  const rows = assetOutcomes(withExtra);
  const keys = new Set(rows.map((r) => r.key));
  for (const key of Object.keys(withExtra.dispositions)) expect(keys.has(key)).toBe(true);
  expect(rows.find((r) => r.key === ARRIVING)).toMatchObject({
    kind: "token",
    code: "token",
    contract: ARRIVING,
    amount: null,
    action: "convert",
  });
  expect(rows.find((r) => r.key === GONE)).toMatchObject({
    kind: "classic",
    code: "GONE",
    issuer: ISSUER_B,
    action: "transfer",
    destination: FRIEND,
  });
});

test("a token's symbol is marked as the contract's own", () => {
  expect(byKey(TOKEN).symbolFromContract).toBe(true);
  expect(byKey(USDC_A).symbolFromContract).toBe(false);
});

test("a balance sent as a JSON number is shown as it came and never converted", () => {
  const base = input();
  const numeric: AssetOutcomeInput = {
    ...base,
    account: {
      ...base.account,
      trustlines: [{ ...base.account.trustlines[0], balance: 5 as unknown as string }],
      claimableBalances: [{ ...base.account.claimableBalances[1], amount: 4 as unknown as string }],
      sorobanTokens: {
        ...base.account.sorobanTokens!,
        tokens: [{ ...base.account.sorobanTokens!.tokens[0], balance: 7 as unknown as string }],
      },
    },
  };
  const rows = assetOutcomes(numeric);
  expect(rows.find((r) => r.key === USDC_A)?.amount).toBe("5");
  expect(rows.find((r) => r.key === TOKEN)?.amount).toBe("7");
  const claim = rows.find((r) => r.key === "cb-native")!;
  expect(claim.amount).toBe("4");
  expect(claim.claimedStroops).toBeNull();
});
