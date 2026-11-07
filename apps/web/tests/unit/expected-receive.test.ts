import { expect, test } from "bun:test";
import { expectedReceive, type ExpectedReceiveInput } from "@/lib/plan/expected-receive";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = "GSOURCE0000000000000000000000000000000000000000000000000";
const TOKEN = "CTOKEN00000000000000000000000000000000000000000000000000";

const classicSwap: AssetConvertibility = {
  asset: "USDC:GISSUER",
  code: "USDC",
  issuer: "GISSUER",
  balance: "5",
  convertible: true,
  quote: { estimatedReceive: "21000000", minAmountOut: "20000000" },
};

const tokenSwap: AssetConvertibility = {
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
};

function nativeClaim(balanceId: string, amount: string): ClaimableBalanceDecision {
  return {
    balanceId,
    asset: "native",
    code: "XLM",
    amount,
    currentlyClaimable: true,
    predicate: { type: "unconditional" },
  };
}

function input(over: Partial<ExpectedReceiveInput> = {}): ExpectedReceiveInput {
  return {
    account: {
      nativeBalanceLumens: "12.5000000",
      numSubEntries: 4,
      numSponsoring: 0,
      defiPositions: emptyDefiPositionsResult(SOURCE),
    },
    planFeeStroops: "500",
    relayForwardUncounted: false,
    conversions: [],
    dispositions: {},
    claims: [],
    claimSelections: {},
    ...over,
  };
}

function expectLinesSum(result: ReturnType<typeof expectedReceive>): void {
  expect(
    BigInt(result.balanceStroops) -
      BigInt(result.feeStroops) +
      BigInt(result.swapStroops) +
      BigInt(result.claimStroops)
  ).toBe(BigInt(result.totalStroops));
}

test("no swaps: the balance less the plan's fee, with the reserve inside the balance", () => {
  const result = expectedReceive(input());
  expect(result.totalStroops).toBe("124999500");
  expect(result.feeStroops).toBe("500");
  expect(result.reserveStroops).toBe("30000000");
  expect(result.estimated).toBe(false);
  expectLinesSum(result);
});

test("a token swap adds its minimum, not its quote", () => {
  const result = expectedReceive(
    input({ conversions: [tokenSwap], dispositions: { [TOKEN]: "convert" } })
  );
  expect(result.swapStroops).toBe("30000000");
  expect(result.tokenSwaps).toBe(1);
  expect(result.totalStroops).toBe("154999500");
  expect(result.estimated).toBe(true);
  expectLinesSum(result);
});

test("a classic swap adds the floor the convert answer sends, 1% under the plan's minimum", () => {
  const result = expectedReceive(
    input({ conversions: [classicSwap], dispositions: { "USDC:GISSUER": "convert" } })
  );
  expect(result.swapStroops).toBe("19800000");
  expectLinesSum(result);
});

test("a declined swap adds nothing", () => {
  const result = expectedReceive(
    input({
      conversions: [classicSwap, tokenSwap],
      dispositions: { "USDC:GISSUER": "transfer", [TOKEN]: "leave" },
    })
  );
  expect(result.swapStroops).toBe("0");
  expect(result.totalStroops).toBe("124999500");
  expect(result.estimated).toBe(false);
  expectLinesSum(result);
});

test("a swap with no estimate counts nothing and is reported", () => {
  const result = expectedReceive(
    input({
      conversions: [{ ...classicSwap, quote: undefined }],
      dispositions: { "USDC:GISSUER": "convert" },
    })
  );
  expect(result.swapStroops).toBe("0");
  expect(result.unquotedSwaps).toBe(1);
  expectLinesSum(result);
});

test("a native claim adds its amount, and a forfeited one adds nothing", () => {
  const claims = [nativeClaim("a", "3.0000000"), nativeClaim("b", "7.0000000")];
  const result = expectedReceive(input({ claims, claimSelections: { a: "claim", b: "forfeit" } }));
  expect(result.claimStroops).toBe("30000000");
  expect(result.totalStroops).toBe("154999500");
  expect(result.estimated).toBe(true);
  expectLinesSum(result);
});

test("a claim of another asset is not XLM and adds nothing", () => {
  const result = expectedReceive(
    input({ claims: [{ ...nativeClaim("c", "9.0000000"), asset: "USDC:GISSUER", code: "USDC" }] })
  );
  expect(result.claimStroops).toBe("0");
});

test("a fee-sponsored plan subtracts no fee", () => {
  const result = expectedReceive(input({ planFeeStroops: "0" }));
  expect(result.feeStroops).toBe("0");
  expect(result.totalStroops).toBe("125000000");
  expectLinesSum(result);
});

test("a relay forward the plan did not count costs one more operation, and the relay keeps nothing else", () => {
  const uncounted = expectedReceive(input({ relayForwardUncounted: true }));
  expect(uncounted.feeStroops).toBe("600");
  expect(uncounted.totalStroops).toBe("124999400");
  expectLinesSum(uncounted);

  const counted = expectedReceive(input({ planFeeStroops: "600" }));
  expect(counted.totalStroops).toBe(uncounted.totalStroops);
});

test("sponsored reserves lower the locked part, and DeFi positions are reported as left out", () => {
  const result = expectedReceive(
    input({
      account: {
        nativeBalanceLumens: "12.5000000",
        numSubEntries: 4,
        numSponsoring: 1,
        numSponsored: 3,
        defiPositions: {
          ...emptyDefiPositionsResult(SOURCE),
          positions: [
            {
              protocol: "blend",
              positionType: "supply",
              contractAddress: "CPOOL000000000000000000000000000000000000000000000000000",
              assetAddress: TOKEN,
              bTokenAmount: "1",
              usdValue: null,
            },
          ],
        },
      },
    })
  );
  expect(result.reserveStroops).toBe("20000000");
  expect(result.leavesOutDefiExits).toBe(true);
  expectLinesSum(result);
});
