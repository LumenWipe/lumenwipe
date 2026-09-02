import { expect, test } from "bun:test";
import { Asset, Networks } from "@stellar/stellar-sdk";
import type { AccountState } from "@/types/account";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { exitRoutersFor, isContractRegistryUsable } from "@/lib/contract-registry";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const PAIR = "CAAZMNZDUPXEPLLJOGVQYQOJPXFYDZRYX2AMSXFYNP7Q5IKY7WCH2ZV4";
/** The bundled registry's Soroswap testnet router. */
const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const TOKEN_0 = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";
const TOKEN_1 = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function state(positions: AccountState["defiPositions"]["positions"]): AccountState {
  return {
    address: ACCOUNT,
    trustlines: [
      { asset: `USDC:${ISSUER}`, code: "USDC", issuer: ISSUER, balance: "1", authorized: true },
    ],
    defiPositions: { positions },
  } as unknown as AccountState;
}

test("no account read vouches for nothing", () => {
  expect(exitExpectations(null, "testnet")).toEqual({
    exitContracts: [],
    heldTokenContracts: [],
    positionTokenContracts: [],
    exitFunctions: {},
  });
});

test("a Blend position pins its pool; XLM and every trustline are held tokens", () => {
  const e = exitExpectations(
    state([
      {
        protocol: "blend",
        positionType: "supply",
        contractAddress: BLEND_POOL,
        assetAddress: TOKEN_0,
        bTokenAmount: "1",
        usdValue: null,
      },
    ]),
    "testnet"
  );
  expect(e.exitContracts).toEqual([BLEND_POOL]);
  expect(e.heldTokenContracts).toEqual([
    Asset.native().contractId(Networks.TESTNET),
    new Asset("USDC", ISSUER).contractId(Networks.TESTNET),
  ]);
  expect(e.positionTokenContracts).toEqual([]);
  expect(e.exitFunctions).toEqual({ [BLEND_POOL]: ["submit"] });
});

test("a Soroswap LP position pins the pair AND the bundled router, and allows the pair's tokens", () => {
  const e = exitExpectations(
    state([
      {
        protocol: "soroswap",
        positionType: "lp",
        contractAddress: PAIR,
        shareAmount: "1",
        usdValue: null,
        tokens: [TOKEN_0, TOKEN_1],
      },
    ]),
    "testnet"
  );
  expect(e.exitContracts).toEqual([PAIR, SOROSWAP_ROUTER]);
  expect(e.positionTokenContracts).toEqual([TOKEN_0, TOKEN_1]);
  // The pair is a position but never a call target; only the router\'s remove_liquidity is.
  expect(e.exitFunctions).toEqual({ [PAIR]: [], [SOROSWAP_ROUTER]: ["remove_liquidity"] });
});

test("routers come only from the bundled registry, for the network and protocols asked, and only while it is valid", () => {
  expect(exitRoutersFor("testnet", ["soroswap"])).toEqual([
    { address: SOROSWAP_ROUTER, protocol: "soroswap" },
  ]);
  expect(exitRoutersFor("testnet", ["blend"])).toEqual([]);
  expect(exitRoutersFor("mainnet", ["soroswap"])).toEqual([]);
  const later = new Date("2100-01-01T00:00:00Z");
  expect(isContractRegistryUsable(later)).toBe(false);
  expect(exitRoutersFor("testnet", ["soroswap"], later)).toEqual([]);
});
