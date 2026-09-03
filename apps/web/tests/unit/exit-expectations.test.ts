import { expect, test } from "bun:test";
import { Asset, Networks } from "@stellar/stellar-sdk";
import type { AccountState } from "@/types/account";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { exitContractsFor, isContractRegistryUsable } from "@/lib/contract-registry";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const PAIR = "CAAZMNZDUPXEPLLJOGVQYQOJPXFYDZRYX2AMSXFYNP7Q5IKY7WCH2ZV4";
/** The bundled registry's Soroswap testnet router. */
const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
/** The bundled registry's Blend V2 testnet backstop. */
const BLEND_BACKSTOP = "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA";
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

test("a Blend position pins its pool and the bundled backstop, each to its own calls; XLM and every trustline are held tokens", () => {
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
  expect(e.exitContracts).toEqual([BLEND_POOL, BLEND_BACKSTOP]);
  expect(e.heldTokenContracts).toEqual([
    Asset.native().contractId(Networks.TESTNET),
    new Asset("USDC", ISSUER).contractId(Networks.TESTNET),
  ]);
  expect(e.positionTokenContracts).toEqual([]);
  expect(e.exitFunctions).toEqual({
    [BLEND_POOL]: ["submit", "claim"],
    [BLEND_BACKSTOP]: ["withdraw"],
  });
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

test("routers and backstops come only from the bundled registry, for the network and protocols asked, for protocols that call them, and only while it is valid", () => {
  expect(exitContractsFor("testnet", ["soroswap"], "router")).toEqual([
    { address: SOROSWAP_ROUTER, protocol: "soroswap" },
  ]);
  expect(exitContractsFor("testnet", ["blend"], "router")).toEqual([]);
  // The registry lists an Aquarius router, but an Aquarius exit never calls it.
  expect(exitContractsFor("testnet", ["aquarius"], "router")).toEqual([]);
  expect(exitContractsFor("testnet", ["blend"], "backstop")).toEqual([
    { address: BLEND_BACKSTOP, protocol: "blend" },
  ]);
  expect(exitContractsFor("testnet", ["soroswap"], "backstop")).toEqual([]);
  expect(exitContractsFor("mainnet", ["soroswap"], "router")).toEqual([]);
  const later = new Date("2100-01-01T00:00:00Z");
  expect(isContractRegistryUsable(later)).toBe(false);
  expect(exitContractsFor("testnet", ["soroswap"], "router", later)).toEqual([]);
  expect(exitContractsFor("testnet", ["blend"], "backstop", later)).toEqual([]);
});

test("an Aquarius LP position pins its pool, allows withdraw and claim on it, and treats its share token and pool tokens as places a withdrawal may touch", () => {
  const SHARE_TOKEN = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
  const e = exitExpectations(
    state([
      {
        protocol: "aquarius",
        positionType: "lp",
        contractAddress: PAIR,
        shareAmount: "1",
        usdValue: null,
        tokens: [TOKEN_0, TOKEN_1],
        shareToken: SHARE_TOKEN,
        poolType: "constant_product",
      },
    ]),
    "testnet"
  );
  // The pool is called directly; the Aquarius router is never a call target.
  expect(e.exitContracts).toEqual([PAIR]);
  expect(e.exitFunctions).toEqual({ [PAIR]: ["withdraw", "claim"] });
  expect(e.positionTokenContracts).toEqual([TOKEN_0, TOKEN_1, SHARE_TOKEN]);
});
