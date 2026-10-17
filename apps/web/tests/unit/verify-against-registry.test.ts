/**
 * The trust anchor, run against the expectations the BUNDLED REGISTRY actually produces.
 *
 * Every other `verify()` test builds its expectation by hand, and each one sets either
 * `exitContracts` or `conversionContracts` empty. That is why nobody noticed that Soroswap's
 * router is in both: a token conversion is entered through it, and a Soroswap LP exit calls
 * `remove_liquidity` on it. In production, where both lists are filled from the registry, the
 * swap rules claimed every operation on that contract and rejected the exit as a malformed swap.
 * No Soroswap position could be closed from the browser at all (PR #270).
 *
 * None of the 14 end-to-end specs closes that gap either: they sign with the SDK directly and
 * never call `assertCloseIntent`, so they prove the API builds a correct exit and prove nothing
 * about whether the product will accept it.
 *
 * So these tests do the one thing neither layer did: derive the expectation exactly as
 * `useCloseExecution` does, from a real account read and the real registry, and put a realistic
 * exit through the anchor.
 */
import { expect, test, describe } from "bun:test";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import type { AccountState } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";
import { assertCloseIntent, type CloseExpectation } from "@/lib/stellar/verify";
import embeddedRegistry from "@registry/contract-registry.json";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { isContractRegistryUsable } from "@/lib/contract-registry";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import realAggregatorSwap from "../../../api/tests/unit/fixtures/soroswap-aggregator-v2-swap.json";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const NOW = 1_800_000_000;
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

/** Registry testnet addresses, the ones detection actually reports. */
const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const SOROSWAP_PAIR = "CDH4NEG6TAII2AXGJY52WSMMOGCPMFIQBBH245ATW2TIZ7MBYM23YOAR";
const AQUARIUS_POOL = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";
const XTAR = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";
const PHOENIX_POOL = "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV";
const PHOENIX_STAKE = "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP";
const FXDAO_VAULT = "CBUZ5NJKA5PRS4TBPHWMN4JGGRVIOQOKI4JUYLA2IXS3BEJKQKEWFW7D";

function accountWith(positions: AccountState["defiPositions"]["positions"]): AccountState {
  return {
    address: SRC,
    trustlines: [],
    defiPositions: { positions },
  } as unknown as AccountState;
}

/** Assembled the way `useCloseExecution` does: the fixed half by hand, the exit half from the
 *  registry. Only the second half is under test. */
function expectationFor(account: AccountState): CloseExpectation {
  return {
    source: SRC,
    destination: DEST,
    mediatorRequired: false,
    nativeBalance: "100.0000000",
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    transfers: {},
    tokenTransfers: {},
    classicConversions: {},
    tokenConversions: {},
    accountSigners: [{ key: SRC, weight: 1, type: "ed25519_public_key" }],
    accountThresholds: { low: 0, med: 1, high: 1 },
    nowSeconds: NOW,
    ...exitExpectations(account, "testnet"),
  } as CloseExpectation;
}

function exitOnly(op: IntentOperation): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
    maxTime: String(NOW + 300),
    memo: null,
    memoType: null,
    guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [op],
  };
}

function call(contract: string, fn: string, referenced: string[] = []): IntentOperation {
  return {
    source: SRC,
    type: "invoke_host_function",
    contract,
    function: fn,
    args: [],
    accountsReferenced: [SRC],
    contractsReferenced: [contract, ...referenced],
    unsupportedAddressCount: 0,
    authorizesBeyondSelf: false,
    authDepth: 0,
    subInvocations: [],
  } as unknown as IntentOperation;
}

test("the registry is usable, or every expectation below would be empty and prove nothing", () => {
  expect(isContractRegistryUsable(new Date())).toBe(true);
});

describe("an exit the registry vouches for passes the anchor", () => {
  test("Blend, through the pool's own submit", () => {
    const account = accountWith([
      {
        protocol: "blend",
        positionType: "supply",
        contractAddress: BLEND_POOL,
        assetAddress: XLM_SAC,
        bTokenAmount: "1",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);

    expect(() =>
      assertCloseIntent(exitOnly(call(BLEND_POOL, "submit", [XLM_SAC])), expectationFor(account))
    ).not.toThrow();
  });

  test("Aquarius, through the pool's own withdraw", () => {
    const account = accountWith([
      {
        protocol: "aquarius",
        positionType: "lp",
        contractAddress: AQUARIUS_POOL,
        shareAmount: "1",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);

    expect(() =>
      assertCloseIntent(exitOnly(call(AQUARIUS_POOL, "withdraw")), expectationFor(account))
    ).not.toThrow();
  });

  test("Phoenix, through the pool's own withdraw_liquidity", () => {
    const account = accountWith([
      {
        protocol: "phoenix",
        positionType: "lp",
        contractAddress: PHOENIX_POOL,
        shareAmount: "1",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);

    expect(() =>
      assertCloseIntent(exitOnly(call(PHOENIX_POOL, "withdraw_liquidity")), expectationFor(account))
    ).not.toThrow();
  });

  /**
   * The regression that matters here: Phoenix's unbond runs on a contract the position itself
   * never names (`live.stakeContract`, read from the pool's own config), sourced only from the
   * bundled registry's "stake" kind - the same shape Blend's backstop already exercises, now
   * proven against Phoenix's real testnet registry entry rather than a hand-built address.
   */
  test("Phoenix, through the registry's stake contract for a staked position's unbond", () => {
    const account = accountWith([
      {
        protocol: "phoenix",
        positionType: "stake",
        contractAddress: PHOENIX_POOL,
        stakedAmount: "1",
        stakedAtEpoch: "1700000000",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);
    const expected = expectationFor(account);

    expect(expected.exitContracts).toContain(PHOENIX_STAKE);

    expect(() =>
      assertCloseIntent(exitOnly(call(PHOENIX_STAKE, "unbond")), expected)
    ).not.toThrow();
  });

  test("FxDAO, through the vault's own pay_debt", () => {
    const account = accountWith([
      {
        protocol: "fxdao",
        positionType: "cdp",
        contractAddress: FXDAO_VAULT,
        denomination: "USDx",
        collateralAmount: "100",
        debtAmount: "50",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);

    expect(() =>
      assertCloseIntent(exitOnly(call(FXDAO_VAULT, "pay_debt")), expectationFor(account))
    ).not.toThrow();
  });

  /**
   * The regression that matters: the Soroswap exit calls the router, and the router is also a
   * conversion contract. This is the case production had and no fixture did.
   */
  test("Soroswap, through the router that is also a conversion contract", () => {
    const account = accountWith([
      {
        protocol: "soroswap",
        positionType: "lp",
        contractAddress: SOROSWAP_PAIR,
        shareAmount: "1",
        tokens: [XTAR, XLM_SAC],
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);
    const expected = expectationFor(account);

    // The overlap is real, not hypothetical - if this ever stops being true the test below is
    // no longer covering anything and should be revisited rather than quietly passing.
    expect(expected.conversionContracts).toContain(SOROSWAP_ROUTER);
    expect(expected.exitContracts).toContain(SOROSWAP_ROUTER);

    expect(() =>
      assertCloseIntent(
        exitOnly(call(SOROSWAP_ROUTER, "remove_liquidity", [SOROSWAP_PAIR, XTAR, XLM_SAC])),
        expected
      )
    ).not.toThrow();
  });
});

describe("the dual role does not widen what the anchor accepts", () => {
  const account = accountWith([
    {
      protocol: "soroswap",
      positionType: "lp",
      contractAddress: SOROSWAP_PAIR,
      shareAmount: "1",
      tokens: [XTAR, XLM_SAC],
      usdValue: null,
    },
  ] as AccountState["defiPositions"]["positions"]);

  test("a swap on the router still has to be one the user chose", () => {
    expect(() =>
      assertCloseIntent(
        exitOnly(call(SOROSWAP_ROUTER, "swap_exact_tokens_for_tokens")),
        expectationFor(account)
      )
    ).toThrow();
  });

  test("a function that is neither a swap nor that protocol's exit is refused", () => {
    expect(() =>
      assertCloseIntent(exitOnly(call(SOROSWAP_ROUTER, "add_liquidity")), expectationFor(account))
    ).toThrow(/function LumenWipe does not use to leave this protocol/);
  });

  test("a contract the account holds no position in is refused, registry or not", () => {
    expect(() =>
      assertCloseIntent(exitOnly(call(BLEND_POOL, "submit")), expectationFor(account))
    ).toThrow(/not one of this account's detected positions/);
  });
});

describe("Phoenix's pool and stake contract each pin their own function only", () => {
  const account = accountWith([
    {
      protocol: "phoenix",
      positionType: "stake",
      contractAddress: PHOENIX_POOL,
      stakedAmount: "1",
      stakedAtEpoch: "1700000000",
      usdValue: null,
    },
  ] as AccountState["defiPositions"]["positions"]);

  test("the pool's withdraw_liquidity does not carry over to the stake contract", () => {
    expect(() =>
      assertCloseIntent(
        exitOnly(call(PHOENIX_STAKE, "withdraw_liquidity")),
        expectationFor(account)
      )
    ).toThrow(/function LumenWipe does not use/);
  });

  test("the stake contract's unbond does not carry over to the pool", () => {
    expect(() =>
      assertCloseIntent(exitOnly(call(PHOENIX_POOL, "unbond")), expectationFor(account))
    ).toThrow(/function LumenWipe does not use/);
  });
});

/**
 * The same class of bug PR #270 caught for Soroswap, for xBull: every other xBull test in
 * verify.test.ts hand-builds `conversionContracts: [XBULL_ROUTER]`, so none of them would have
 * caught the router being absent from `conversionContractsFor`'s real filter. xBull is
 * mainnet-only (no testnet entry exists), so this derives the expectation on mainnet, the one
 * network where the regression could actually happen.
 */
describe("xBull's router, derived from the real registry (mainnet, the only network it exists on)", () => {
  const XLM_SAC_MAINNET = Asset.native().contractId(Networks.PUBLIC);
  const XBULL_ROUTER = "CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT";
  const CONVERT_TOKEN = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

  function xbullExpectation(): CloseExpectation {
    return {
      ...expectationFor(accountWith([])),
      ...exitExpectations(accountWith([]), "mainnet"),
      tokenConversions: {
        [CONVERT_TOKEN]: {
          minAmountOut: "1",
          amountOut: "1",
          amountIn: "100000000",
          resolvedPath: [CONVERT_TOKEN, XLM_SAC_MAINNET],
        },
      },
    } as CloseExpectation;
  }

  test("the real registry includes xBull's router in conversionContracts on mainnet", () => {
    expect(xbullExpectation().conversionContracts).toContain(XBULL_ROUTER);
  });

  test("a real strict_send call passes the anchor using the registry-derived expectation", () => {
    const swap: IntentOperation = {
      source: SRC,
      type: "invoke_host_function",
      contract: XBULL_ROUTER,
      function: "strict_send",
      // USDC is index 25 and XLM index 0 in the bundled table read from the live router.
      args: [SRC, SRC, "100000000", "1", "[[4,25,1112,0]]", "[]"],
      accountsReferenced: [SRC],
      contractsReferenced: [XBULL_ROUTER],
      unsupportedAddressCount: 0,
      authorizesBeyondSelf: false,
      authDepth: 0,
      subInvocations: [],
    } as unknown as IntentOperation;
    expect(() => assertCloseIntent(exitOnly(swap), xbullExpectation())).not.toThrow();
    const toUsdcAgain = { ...swap, args: [SRC, SRC, "100000000", "1", "[[4,25,1112,25]]", "[]"] };
    expect(() =>
      assertCloseIntent(exitOnly(toUsdcAgain as IntentOperation), xbullExpectation())
    ).toThrow(/something other than XLM/);
  });
});

test("a swap the Soroswap aggregator really built passes the anchor, and only for the token and floor chosen", () => {
  const capturedAt = Math.floor(Date.parse(realAggregatorSwap.capturedAt) / 1000);
  const intent: TxIntent = {
    ...intentFromXdr(realAggregatorSwap.xdr, Networks.PUBLIC),
    maxTime: String(capturedAt + 300),
  };
  const account = { ...accountWith([]), address: realAggregatorSwap.account } as AccountState;
  const expected = (minAmountOut: string): CloseExpectation =>
    ({
      ...expectationFor(account),
      ...exitExpectations(account, "mainnet"),
      source: realAggregatorSwap.account,
      nowSeconds: capturedAt,
      tokenConversions: {
        [realAggregatorSwap.token]: {
          minAmountOut,
          amountOut: minAmountOut,
          amountIn: realAggregatorSwap.amountIn,
        },
      },
    }) as CloseExpectation;
  expect(() => assertCloseIntent(intent, expected(realAggregatorSwap.minAmountOut))).not.toThrow();
  expect(() =>
    assertCloseIntent(intent, expected(String(BigInt(realAggregatorSwap.minAmountOut) + BigInt(1))))
  ).toThrow(/less XLM than the minimum/);
});

describe("mainnet exits through every live pool the registry lists, not only its representatives", () => {
  const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const USDC = new Asset("USDC", USDC_ISSUER).contractId(Networks.PUBLIC);
  const XLM = Asset.native().contractId(Networks.PUBLIC);
  const YIELDBLOX_V1 = "CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB";
  const YIELDBLOX_V2 = "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS";
  const UNLISTED_POOL = StrKey.encodeContract(Buffer.alloc(32, 7));
  const PHOENIX_XLM_USDC = "CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX";
  const PHOENIX_XLM_USDC_SHARE = "CBTCSVZBJFGMW7E2LKFKRIUARUKZK2DTBUC7X5QPQJLXMAH42DB3ALE5";
  const AQUARIUS_UNLISTED_POOL = StrKey.encodeContract(Buffer.alloc(32, 8));
  const AQUARIUS_SHARE = StrKey.encodeContract(Buffer.alloc(32, 9));

  function mainnetAccount(
    positions: AccountState["defiPositions"]["positions"],
    sorobanTokens: Array<{ contract: string; balance: string }> = []
  ): AccountState {
    return {
      address: SRC,
      trustlines: [
        {
          asset: `USDC:${USDC_ISSUER}`,
          code: "USDC",
          issuer: USDC_ISSUER,
          balance: "5",
          isAuthorized: true,
          isAuthorizedToMaintainLiabilities: false,
        },
      ],
      sorobanTokens: { tokens: sorobanTokens },
      defiPositions: { positions },
    } as unknown as AccountState;
  }

  const mainnetExpectation = (account: AccountState): CloseExpectation =>
    ({ ...expectationFor(account), ...exitExpectations(account, "mainnet") }) as CloseExpectation;

  function blendBorrow(pool: string, asset: string): AccountState["defiPositions"]["positions"] {
    return [
      {
        protocol: "blend",
        positionType: "borrow",
        contractAddress: pool,
        assetAddress: asset,
        dTokenAmount: "1",
        usdValue: null,
      },
      {
        protocol: "blend",
        positionType: "supply",
        contractAddress: pool,
        assetAddress: XLM,
        bTokenAmount: "1",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"];
  }

  function repayAndWithdraw(pool: string, repaid: string): IntentOperation {
    return {
      ...call(pool, "submit", [repaid, XLM]),
      subInvocations: [{ contract: repaid, function: "transfer", args: [SRC, pool, "1000"] }],
    } as unknown as IntentOperation;
  }

  test("a Blend repay and withdraw that pays USDC into YieldBlox V2 passes", () => {
    const account = mainnetAccount(blendBorrow(YIELDBLOX_V2, USDC));
    expect(() =>
      assertCloseIntent(exitOnly(repayAndWithdraw(YIELDBLOX_V2, USDC)), mainnetExpectation(account))
    ).not.toThrow();
  });

  test("a Blend repay that pays XLM into YieldBlox V1 passes", () => {
    const account = mainnetAccount(blendBorrow(YIELDBLOX_V1, XLM));
    expect(() =>
      assertCloseIntent(exitOnly(repayAndWithdraw(YIELDBLOX_V1, XLM)), mainnetExpectation(account))
    ).not.toThrow();
  });

  test("the same repay into a pool the registry does not list is still refused", () => {
    const account = mainnetAccount(blendBorrow(UNLISTED_POOL, USDC));
    expect(() =>
      assertCloseIntent(
        exitOnly(repayAndWithdraw(UNLISTED_POOL, USDC)),
        mainnetExpectation(account)
      )
    ).toThrow(/contract LumenWipe has not verified/);
  });

  test("a Phoenix withdraw_liquidity on a pool other than the representative one passes", () => {
    const account = mainnetAccount(
      [
        {
          protocol: "phoenix",
          positionType: "lp",
          contractAddress: PHOENIX_XLM_USDC,
          shareAmount: "1",
          usdValue: null,
        },
      ] as AccountState["defiPositions"]["positions"],
      [{ contract: PHOENIX_XLM_USDC_SHARE, balance: "1000" }]
    );
    const withdraw = {
      ...call(PHOENIX_XLM_USDC, "withdraw_liquidity", [PHOENIX_XLM_USDC_SHARE]),
      subInvocations: [
        {
          contract: PHOENIX_XLM_USDC_SHARE,
          function: "transfer",
          args: [SRC, PHOENIX_XLM_USDC, "1000"],
        },
      ],
    } as unknown as IntentOperation;
    expect(() => assertCloseIntent(exitOnly(withdraw), mainnetExpectation(account))).not.toThrow();
  });

  test("a Phoenix unbond passes on every stake contract the registry lists, and on no other", () => {
    const account = mainnetAccount([
      {
        protocol: "phoenix",
        positionType: "stake",
        contractAddress: PHOENIX_XLM_USDC,
        stakedAmount: "1",
        stakedAtEpoch: "1700000000",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);
    const stakes = embeddedRegistry.entries
      .filter((e) => e.network === "mainnet" && e.protocol === "phoenix" && e.kind === "stake")
      .map((e) => e.address);
    expect(stakes).toHaveLength(11);
    for (const stake of stakes) {
      expect(() =>
        assertCloseIntent(exitOnly(call(stake, "unbond")), mainnetExpectation(account))
      ).not.toThrow();
    }
    expect(() =>
      assertCloseIntent(exitOnly(call(UNLISTED_POOL, "unbond")), mainnetExpectation(account))
    ).toThrow();
  });

  test("an Aquarius withdraw on an unlisted pool burns only its own share token, so it passes", () => {
    const account = mainnetAccount([
      {
        protocol: "aquarius",
        positionType: "lp",
        contractAddress: AQUARIUS_UNLISTED_POOL,
        shareAmount: "1",
        tokens: [XLM, USDC],
        shareToken: AQUARIUS_SHARE,
        poolType: "constant_product",
        usdValue: null,
      },
    ] as AccountState["defiPositions"]["positions"]);
    const withdraw = {
      ...call(AQUARIUS_UNLISTED_POOL, "withdraw", [AQUARIUS_SHARE]),
      subInvocations: [{ contract: AQUARIUS_SHARE, function: "burn", args: [SRC, "1000"] }],
    } as unknown as IntentOperation;
    expect(mainnetExpectation(account).registryContracts).not.toContain(AQUARIUS_UNLISTED_POOL);
    expect(() => assertCloseIntent(exitOnly(withdraw), mainnetExpectation(account))).not.toThrow();
  });
});
