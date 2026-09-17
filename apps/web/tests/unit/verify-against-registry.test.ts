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
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import type { AccountState } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";
import { assertCloseIntent, type CloseExpectation } from "@/lib/stellar/verify";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { isContractRegistryUsable } from "@/lib/contract-registry";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

/** Registry testnet addresses, the ones detection actually reports. */
const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const SOROSWAP_PAIR = "CDH4NEG6TAII2AXGJY52WSMMOGCPMFIQBBH245ATW2TIZ7MBYM23YOAR";
const AQUARIUS_POOL = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";
const XTAR = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";

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
    tokenConversions: {},
    accountSigners: [{ key: SRC, weight: 1, type: "ed25519_public_key" }],
    accountThresholds: { low: 0, med: 1, high: 1 },
    ...exitExpectations(account, "testnet"),
  } as CloseExpectation;
}

function exitOnly(op: IntentOperation): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
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
