import type { AccountState } from "@/types/account";
import { sorobanTokensOf } from "./soroban-tokens";
import { emptyDefiPositionsResult } from "./defi-positions";
import { freshAccount } from "./account";

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
  account: AccountState;
}

const PHOENIX_SOURCE = "GAWUMI6YMUTH475MCQ7RGTVLEK52LBAX6BW6XN2IRYZPMHNPZQ77C67Y";
const FXDAO_SOURCE = "GB3JGEKH5QTFJQJFIHOJJRENHIEBMYWZ5DT6IE3M6XII7M5MIEDVTSBD";
const PHOENIX_POOL = "CA4V7YVUC3EE2EFVTEYJ47ZD34K4DCAKEYV6AHRR73KTKO5GDGNZLLMT";
const PHOENIX_SHARE_TOKEN = "CDZPFQQU6EZVRKC7CJD6I6KIBKTBI76TLC75HA72PWLTCJ446ZNLNRGR";
const FXDAO_VAULT = "CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N";
const FXDAO_USD_TOKEN = "CAEGVALLV7CA2SIFEDJNA52RKGUWRQWQXM5YNFUH7TH5G6X6QXMRQM4L";

/** The account read the API returns for the exit's account. `tokens` is what Soroban token
 *  discovery confirmed: a Phoenix share token is never among them (the position carries it), an
 *  FxDAO vault's stablecoin is, through the position that names it. */
function accountWith(
  address: string,
  position: AccountState["defiPositions"]["positions"][number],
  tokens: { contract: string; balance: string }[]
): AccountState {
  return freshAccount(address, {
    nativeBalanceLumens: "100.0000000",
    signers: [{ key: address, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
    defiPositions: { ...emptyDefiPositionsResult(address), positions: [position] },
    sorobanTokens: sorobanTokensOf(
      tokens.map((t) => ({ ...t, symbol: null, decimals: 7, sources: ["positions"] }))
    ),
  });
}

export const REAL_EXIT_ENVELOPES: RealExitEnvelope[] = [
  {
    name: "Phoenix withdraw_liquidity",
    provenance: {
      network: "testnet",
      capturedAt: "2026-11-18T22:22:43.675Z",
      adapter: "apps/api/src/lib/defi-exits/phoenix.ts as changed by #1048, on 2bd77ad",
      origin: "Built, signed and submitted: ledger 5803385, successful.",
      limits:
        "The pool is the project's own testnet deployment of the mainnet v1 pool code, listed in " +
        "the contract registry. The account state below is hand-written from the same plan step; " +
        "its share token is the pool's CONFIG.share_token, read live on 2026-11-18.",
    },
    xdr: "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",
    expected: {
      hash: "899a7170c24d7819dee895beb2976ef12e5ef5a5a50d1d31ae60c4694ef1dbf8",
      source: PHOENIX_SOURCE,
      contract: PHOENIX_POOL,
      function: "withdraw_liquidity",
      rootAmountArg: 1,
      fee: "26722",
      maxTime: "1795040863",
      tokenCall: { contract: PHOENIX_SHARE_TOKEN, function: "transfer", amountArg: 2 },
    },
    account: accountWith(
      PHOENIX_SOURCE,
      {
        protocol: "phoenix",
        positionType: "lp",
        contractAddress: PHOENIX_POOL,
        shareAmount: "1000000",
        shareToken: PHOENIX_SHARE_TOKEN,
        usdValue: null,
      },
      []
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
        "hand-written; its vault figures match the ledger entry, and its debt token is the " +
        "vault's Currency(usd).contract, read live on 2026-11-06.",
    },
    xdr: "AAAAAgAAAAB2kxFH7CZUwSVB3JTEjToIFmLZ6OfkE2z10I+zrEEHWQABI88ATjpAAAAAAgAAAAEAAAAAAAAAAAAAAABq5roDAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABSTm8Bg89TABPbT7Cn4PXpzaIebuUnrdi+/Cqa0BAuC4AAAAIcGF5X2RlYnQAAAAEAAAAEAAAAAEAAAABAAAADwAAAAROb25lAAAAEQAAAAEAAAADAAAADwAAAAdhY2NvdW50AAAAABIAAAAAAAAAAHaTEUfsJlTBJUHclMSNOggWYtno5+QTbPXQj7OsQQdZAAAADwAAAAxkZW5vbWluYXRpb24AAAAPAAAAA3VzZAAAAAAPAAAABWluZGV4AAAAAAAACQAAAAAAAAAAAAAAAHac/YAAAAAQAAAAAQAAAAEAAAAPAAAABE5vbmUAAAAJAAAAAAAAAAAAAAAABfXhAAAAAAEAAAAAAAAAAAAAAAFJObwGDz1MAE9tPsKfg9enNoh5u5Set2L78KprQEC4LgAAAAhwYXlfZGVidAAAAAQAAAAQAAAAAQAAAAEAAAAPAAAABE5vbmUAAAARAAAAAQAAAAMAAAAPAAAAB2FjY291bnQAAAAAEgAAAAAAAAAAdpMRR+wmVMElQdyUxI06CBZi2ejn5BNs9dCPs6xBB1kAAAAPAAAADGRlbm9taW5hdGlvbgAAAA8AAAADdXNkAAAAAA8AAAAFaW5kZXgAAAAAAAAJAAAAAAAAAAAAAAAAdpz9gAAAABAAAAABAAAAAQAAAA8AAAAETm9uZQAAAAkAAAAAAAAAAAAAAAAF9eEAAAAAAQAAAAAAAAABCGqBa6/EDUkFINLQd1FRqWjC0Ls7hpaH/M/Tev6F2RgAAAAEYnVybgAAAAIAAAASAAAAAAAAAAB2kxFH7CZUwSVB3JTEjToIFmLZ6OfkE2z10I+zrEEHWQAAAAoAAAAAAAAAAAAAAAAF9eEAAAAAAAAAAAEAAAAAAAAABAAAAAYAAAABCGqBa6/EDUkFINLQd1FRqWjC0Ls7hpaH/M/Tev6F2RgAAAAUAAAAAQAAAAYAAAAB15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAAUAAAAAQAAAAfiafDNJDbzi1Wb1n3hpliSmnxhDJ5yqenuOufFy01zLQAAAAf1UBbOyRkHEqfl5Y4JCHvMiZOT6w2ZNTpf7OR7t5Cn+wAAAAcAAAAAAAAAAHaTEUfsJlTBJUHclMSNOggWYtno5+QTbPXQj7OsQQdZAAAAAAAAAAC8vrrq/N/Z0Zytl0f9P6h1rFnrsXSdCSlnBLPHSB/yMgAAAAYAAAABCGqBa6/EDUkFINLQd1FRqWjC0Ls7hpaH/M/Tev6F2RgAAAAQAAAAAQAAAAIAAAAPAAAAB0JhbGFuY2UAAAAAEgAAAAAAAAAAdpMRR+wmVMElQdyUxI06CBZi2ejn5BNs9dCPs6xBB1kAAAABAAAABgAAAAFJObwGDz1MAE9tPsKfg9enNoh5u5Set2L78KprQEC4LgAAABAAAAABAAAAAgAAAA8AAAAFVmF1bHQAAAAAAAAQAAAAAQAAAAIAAAASAAAAAAAAAAB2kxFH7CZUwSVB3JTEjToIFmLZ6OfkE2z10I+zrEEHWQAAAA8AAAADdXNkAAAAAAEAAAAGAAAAAUk5vAYPPUwAT20+wp+D16c2iHm7lJ63YvvwqmtAQLguAAAAEAAAAAEAAAACAAAADwAAAApWYXVsdEluZGV4AAAAAAARAAAAAQAAAAIAAAAPAAAADGRlbm9taW5hdGlvbgAAAA8AAAADdXNkAAAAAA8AAAAEdXNlcgAAABIAAAAAAAAAAHaTEUfsJlTBJUHclMSNOggWYtno5+QTbPXQj7OsQQdZAAAAAQAAAAYAAAABSTm8Bg89TABPbT7Cn4PXpzaIebuUnrdi+/Cqa0BAuC4AAAAUAAAAAQAAAAYAAAAB15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAAQAAAAAQAAAAIAAAAPAAAAB0JhbGFuY2UAAAAAEgAAAAFJObwGDz1MAE9tPsKfg9enNoh5u5Set2L78KprQEC4LgAAAAEALg4rAAABIAAABvgAAAAAAAEjawAAAAA=",
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
        debtToken: FXDAO_USD_TOKEN,
        usdValue: null,
      },
      [{ contract: FXDAO_USD_TOKEN, balance: "100000000" }]
    ),
  },
];
