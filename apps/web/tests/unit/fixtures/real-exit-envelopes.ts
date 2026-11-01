import type { AccountState } from "@/types/account";

export interface RealExitEnvelope {
  name: string;
  provenance: {
    network: "testnet";
    capturedAt: string;
    /** Exit adapter that built the envelope, with the last commit that touched it. */
    adapter: string;
    /** Whether the envelope reached the ledger, and how to find it. */
    origin: string;
    /** What about this fixture is not a reading of the chain. */
    limits: string;
  };
  xdr: string;
  expected: {
    hash: string;
    source: string;
    contract: string;
    function: string;
    /** Position in the root call's arguments of the amount that leaves the account. */
    rootAmountArg: number;
    fee: string;
    maxTime: string;
    /** The one token call the signature authorizes below the root. */
    tokenCall: { contract: string; function: string; amountArg: number };
  };
  /** Only the fields `exitExpectations` and the expectation around it read. */
  account: AccountState;
}

const PHOENIX_SOURCE = "GAHJYT4JF3P6V3GWZ3PEQWHU3CB55SLWXBGCLCOWLU5Q5UI6CCMXCURP";
const FXDAO_SOURCE = "GB3JGEKH5QTFJQJFIHOJJRENHIEBMYWZ5DT6IE3M6XII7M5MIEDVTSBD";
const PHOENIX_POOL = "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV";
const PHOENIX_SHARE_TOKEN = "CC53IRMBHWTXE4BWPD5N4LH2L43YSYBMOFD6UARPMZBTWPSODFFKW2EG";
const FXDAO_VAULT = "CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N";
const FXDAO_USD_TOKEN = "CAEGVALLV7CA2SIFEDJNA52RKGUWRQWQXM5YNFUH7TH5G6X6QXMRQM4L";

function accountWith(
  address: string,
  position: AccountState["defiPositions"]["positions"][number],
  token: { contract: string; balance: string }
): AccountState {
  return {
    address,
    nativeBalanceLumens: "100.0000000",
    signers: [{ key: address, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
    trustlines: [],
    defiPositions: { positions: [position] },
    sorobanTokens: { tokens: [{ ...token, symbol: null, decimals: 7, sources: ["list"] }] },
  } as unknown as AccountState;
}

export const REAL_EXIT_ENVELOPES: RealExitEnvelope[] = [
  {
    name: "Phoenix withdraw_liquidity",
    provenance: {
      network: "testnet",
      capturedAt: "2026-11-01T03:56:27.926Z",
      adapter: "apps/api/src/lib/defi-exits/phoenix.ts at f699a23",
      origin: "Built, signed and submitted: ledger 5496350, successful.",
      limits:
        "The pool is the project's own testnet redeploy of Phoenix's mainnet wasm, listed in the " +
        "contract registry. The account state below is hand-written from the same plan step.",
    },
    xdr: "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",
    expected: {
      hash: "7ab0e8780dde5dc2d76668fad21af26b8e4d4c26b5cf4dc4b6f1bf18ccfb7025",
      source: PHOENIX_SOURCE,
      contract: PHOENIX_POOL,
      function: "withdraw_liquidity",
      rootAmountArg: 1,
      fee: "26609",
      maxTime: "1793505687",
      tokenCall: { contract: PHOENIX_SHARE_TOKEN, function: "transfer", amountArg: 2 },
    },
    account: accountWith(
      PHOENIX_SOURCE,
      {
        protocol: "phoenix",
        positionType: "lp",
        contractAddress: PHOENIX_POOL,
        shareAmount: "388315",
        usdValue: null,
      },
      { contract: PHOENIX_SHARE_TOKEN, balance: "388315" }
    ),
  },
  {
    name: "FxDAO pay_debt",
    provenance: {
      network: "testnet",
      capturedAt: "2026-11-01T03:58:16.167Z",
      adapter: "apps/api/src/lib/defi-exits/fxdao.ts at f699a23",
      origin: "Built and simulated only, never submitted, from a friendbot-funded account.",
      limits:
        "The vault is the project's own testnet redeploy of FxDAO's open-source contract. The " +
        "adapter's health gate was stubbed for the capture. The account state below is " +
        "hand-written; its vault figures match the ledger entry.",
    },
    xdr: "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",
    expected: {
      hash: "3bbb1e20b58d103e0b52e336ceee5146bd839dd65543c90613033e1cd983995f",
      source: FXDAO_SOURCE,
      contract: FXDAO_VAULT,
      function: "pay_debt",
      rootAmountArg: 3,
      fee: "74703",
      maxTime: "1793505795",
      tokenCall: { contract: FXDAO_USD_TOKEN, function: "burn", amountArg: 1 },
    },
    account: accountWith(
      FXDAO_SOURCE,
      {
        protocol: "fxdao",
        positionType: "cdp",
        contractAddress: FXDAO_VAULT,
        denomination: "usd",
        collateralAmount: "199000000",
        debtAmount: "100000000",
        usdValue: null,
      },
      { contract: FXDAO_USD_TOKEN, balance: "100000000" }
    ),
  },
];
