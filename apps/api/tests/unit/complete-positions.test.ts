/**
 * Completing an indexer's LP positions from the ledger: what OctoPos leaves out (an Aquarius
 * pool's tokens, share token, and code type; a Soroswap pair's tokens; a Phoenix pool's share
 * token), read from the same keys the testnet sweep decodes, and left alone whenever that read
 * cannot be trusted.
 */
import { describe, expect, test } from "bun:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type {
  AquariusLpPosition,
  DefiPositionsResult,
  PhoenixLpPosition,
  PhoenixStakePosition,
  SoroswapLpPosition,
} from "@lumenwipe/types";
import {
  MAX_COMPLETION_READS,
  completePositionsFromLedger,
  type CompletePositionsDeps,
} from "@/lib/defi-positions/complete-positions";
import type { ContractResolution } from "@/lib/contract-registry";
import {
  contractDataEntry,
  contractInstanceEntry,
  mockRpc,
  structVal,
} from "./fixtures/testnet-direct-read-helpers";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const AQ_POOL = "CCSY43EHJAHT3NQDYKAMJXRFBEEH7OXDL3J3VNGO33UUSEXWNN27GBIZ";
const AQ_SHARE = "CC4BPROIXISEFC7UKTB2HYBLNSNP27WNCR7YNZOHXLTPTGDKFMKYQ2YN";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const AQUA_SAC = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";
const PAIR = "CB46LMGJC7SYSH4C7SBNLV635OX5BSNQDGRR32NRXAV7N2AVNZMQUJ3A";
const TOKEN_0 = "CBCU5VMZ3GNHHKJUWZ2GI7K36MEAXOJW2RJCIJHFPVFGBME3WADLXA6W";
const TOKEN_1 = "CCBJNX4B23ZDXEE3KRS2IAQJSLNQY4ZJ24K44BI7FYYIF5ZAZMRYPRRD";
const CONSTANT_HASH = "d691135aade93ff0f7c229e009cde042130a05124cf7202b03d11246b4f9b473";
const STABLE_HASH = "22dff7242d2bc0ea4a4727b4b2cac33b188304d5945740ad24d8a33a5d22741e";
const PAIR_HASH = "18051456816b66f12e773a56f77c5794fac1b1fb7ab6e22d4fad5a412770f73e";
const UNKNOWN_HASH = "9".repeat(64);
const PHX_POOL = "CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX";
/** Read live from that mainnet pool's `CONFIG` on 2026-11-06: not the pool itself. */
const PHX_SHARE = "CBTCSVZBJFGMW7E2LKFKRIUARUKZK2DTBUC7X5QPQJLXMAH42DB3ALE5";
const PHX_STAKE = "CAF3UJ45ZQJP6USFUIMVMGOUETUTXEC35R2247VJYIVQBGKTKBZKNBJ3";
const PHX_POOL_HASH = "167ab414a226427de34c19947ef9c5cf38c6c0ed91ecf9392f7cef3278ff506c";

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

const aquarius: AquariusLpPosition = {
  protocol: "aquarius",
  positionType: "lp",
  contractAddress: AQ_POOL,
  shareAmount: "100",
  usdValue: null,
};
const phoenix: PhoenixLpPosition = {
  protocol: "phoenix",
  positionType: "lp",
  contractAddress: PHX_POOL,
  shareAmount: "7",
  usdValue: null,
};
const soroswap: SoroswapLpPosition = {
  protocol: "soroswap",
  positionType: "lp",
  contractAddress: PAIR,
  shareAmount: "5",
  usdValue: null,
};

function result(positions: DefiPositionsResult["positions"]): DefiPositionsResult {
  return { ...emptyDefiPositionsResult(ACCOUNT, "mainnet"), positions };
}

/** A registry knowing one Aquarius pool code per type and the Soroswap pair code. */
const registry = (_n: string, hash: string): ContractResolution => {
  const known = (
    protocol: "aquarius" | "soroswap" | "phoenix",
    kind: "pool" | "pair",
    version: string
  ) => ({ status: "known", protocol, kind, version, wasmHash: hash }) as const;
  if (hash === CONSTANT_HASH) return known("aquarius", "pool", "constant_product");
  if (hash === STABLE_HASH) return known("aquarius", "pool", "stable");
  if (hash === PAIR_HASH) return known("soroswap", "pair", "v1");
  if (hash === PHX_POOL_HASH) return known("phoenix", "pool", "v1");
  return { status: "unknown", wasmHash: hash };
};

/** A Phoenix pool's persistent `CONFIG`, as the live pool lays it out. */
const phoenixConfig = (pool: string, shareToken: xdr.ScVal) =>
  contractDataEntry(
    pool,
    xdr.ScVal.scvSymbol("CONFIG"),
    structVal({
      token_a: addr(XLM_SAC),
      token_b: addr(AQUA_SAC),
      share_token: shareToken,
      stake_contract: addr(PHX_STAKE),
    })
  );

function deps(entries: ReturnType<typeof contractInstanceEntry>[]): CompletePositionsDeps {
  return { rpc: mockRpc(entries), resolveWasmHash: registry };
}

describe("completing LP positions from the ledger", () => {
  test("an Aquarius position gains its tokens, share token, and the code type the registry knows", async () => {
    const pool = contractInstanceEntry(AQ_POOL, CONSTANT_HASH, [
      [sym("TokenA"), addr(XLM_SAC)],
      [sym("TokenB"), addr(AQUA_SAC)],
      [sym("TokenShare"), addr(AQ_SHARE)],
    ]);
    const out = await completePositionsFromLedger(result([aquarius]), "mainnet", deps([pool]));
    expect(out.positions[0]).toEqual({
      ...aquarius,
      tokens: [XLM_SAC, AQUA_SAC],
      shareToken: AQ_SHARE,
      poolType: "constant_product",
    });
  });

  test("a stableswap pool lists its tokens as one vector", async () => {
    const pool = contractInstanceEntry(AQ_POOL, STABLE_HASH, [
      [sym("Tokens"), xdr.ScVal.scvVec([addr(XLM_SAC), addr(AQUA_SAC)])],
      [sym("TokenShare"), addr(AQ_SHARE)],
    ]);
    const out = await completePositionsFromLedger(result([aquarius]), "mainnet", deps([pool]));
    expect(out.positions[0]).toEqual({
      ...aquarius,
      tokens: [XLM_SAC, AQUA_SAC],
      shareToken: AQ_SHARE,
      poolType: "stable",
    });
  });

  test("a contract whose code the registry does not know nominates nothing: what a position names, the anchor admits", async () => {
    const stranger = contractInstanceEntry(AQ_POOL, UNKNOWN_HASH, [
      [sym("TokenA"), addr(XLM_SAC)],
      [sym("TokenB"), addr(AQUA_SAC)],
      [sym("TokenShare"), addr(AQ_SHARE)],
    ]);
    expect(
      (await completePositionsFromLedger(result([aquarius]), "mainnet", deps([stranger]))).positions
    ).toEqual([aquarius]);
    // Known code, but of the other protocol or kind: still nothing.
    const asPair = contractInstanceEntry(AQ_POOL, PAIR_HASH, [
      [sym("TokenA"), addr(XLM_SAC)],
      [sym("TokenB"), addr(AQUA_SAC)],
    ]);
    expect(
      (await completePositionsFromLedger(result([aquarius]), "mainnet", deps([asPair]))).positions
    ).toEqual([aquarius]);
    const pairAsPool = contractInstanceEntry(PAIR, CONSTANT_HASH, [
      [xdr.ScVal.scvU32(0), addr(TOKEN_0)],
      [xdr.ScVal.scvU32(1), addr(TOKEN_1)],
    ]);
    expect(
      (await completePositionsFromLedger(result([soroswap]), "mainnet", deps([pairAsPool])))
        .positions
    ).toEqual([soroswap]);
  });

  test("tokens must be two or more distinct contracts; an account or a lone token is not a token list", async () => {
    const lone = contractInstanceEntry(AQ_POOL, STABLE_HASH, [
      [sym("Tokens"), xdr.ScVal.scvVec([addr(XLM_SAC)])],
      [sym("TokenShare"), addr(AQ_SHARE)],
    ]);
    expect(
      (await completePositionsFromLedger(result([aquarius]), "mainnet", deps([lone]))).positions[0]
    ).toEqual({ ...aquarius, shareToken: AQ_SHARE, poolType: "stable" });
    const twice = contractInstanceEntry(AQ_POOL, STABLE_HASH, [
      [sym("Tokens"), xdr.ScVal.scvVec([addr(XLM_SAC), addr(XLM_SAC)])],
    ]);
    expect(
      (await completePositionsFromLedger(result([aquarius]), "mainnet", deps([twice]))).positions[0]
    ).toEqual({ ...aquarius, poolType: "stable" });
    const account = contractInstanceEntry(AQ_POOL, CONSTANT_HASH, [
      [sym("TokenA"), addr(XLM_SAC)],
      [sym("TokenB"), addr(ACCOUNT)],
      [sym("TokenShare"), addr(ACCOUNT)],
    ]);
    expect(
      (await completePositionsFromLedger(result([aquarius]), "mainnet", deps([account])))
        .positions[0]
    ).toEqual({ ...aquarius, poolType: "constant_product" });
  });

  test("a Soroswap position gains the pair's two tokens", async () => {
    const pair = contractInstanceEntry(PAIR, PAIR_HASH, [
      [xdr.ScVal.scvU32(0), addr(TOKEN_0)],
      [xdr.ScVal.scvU32(1), addr(TOKEN_1)],
    ]);
    const out = await completePositionsFromLedger(result([soroswap]), "mainnet", deps([pair]));
    expect(out.positions[0]).toEqual({ ...soroswap, tokens: [TOKEN_0, TOKEN_1] });
  });

  test("a Phoenix LP position gains the share token its pool's CONFIG names, a contract apart from the pool", async () => {
    const entries = [
      contractInstanceEntry(PHX_POOL, PHX_POOL_HASH),
      phoenixConfig(PHX_POOL, addr(PHX_SHARE)),
    ];
    const out = await completePositionsFromLedger(result([phoenix]), "mainnet", deps(entries));
    expect(out.positions[0]).toEqual({ ...phoenix, shareToken: PHX_SHARE });
    expect(PHX_SHARE).not.toBe(PHX_POOL);
  });

  test("a Phoenix share token comes only from a pool the registry knows, and only as a contract", async () => {
    const config = phoenixConfig(PHX_POOL, addr(PHX_SHARE));
    for (const hash of [UNKNOWN_HASH, CONSTANT_HASH]) {
      const out = await completePositionsFromLedger(
        result([phoenix]),
        "mainnet",
        deps([contractInstanceEntry(PHX_POOL, hash), config])
      );
      expect(out.positions).toEqual([phoenix]);
    }
    const instance = contractInstanceEntry(PHX_POOL, PHX_POOL_HASH);
    // An account is never a share token; a pool with no CONFIG names none.
    for (const entries of [[instance, phoenixConfig(PHX_POOL, addr(ACCOUNT))], [instance]]) {
      const out = await completePositionsFromLedger(result([phoenix]), "mainnet", deps(entries));
      expect(out.positions).toEqual([phoenix]);
    }
    // An entry under any other key is not the pool's CONFIG, even when the RPC hands it back.
    const misplaced = contractDataEntry(
      PHX_POOL,
      xdr.ScVal.scvSymbol("CONFIGS"),
      structVal({ share_token: addr(PHX_SHARE) })
    );
    const indiscriminate: CompletePositionsDeps = {
      rpc: { getLedgerEntries: async () => ({ latestLedger: 1, entries: [instance, misplaced] }) },
      resolveWasmHash: registry,
    };
    expect(
      (await completePositionsFromLedger(result([phoenix]), "mainnet", indiscriminate)).positions
    ).toEqual([phoenix]);
  });

  test("a Phoenix stake position is left as reported: unbonding names no share token", async () => {
    const stake: PhoenixStakePosition = {
      protocol: "phoenix",
      positionType: "stake",
      contractAddress: PHX_POOL,
      stakedAmount: "1",
      stakedAtEpoch: "1",
      usdValue: null,
    };
    let reads = 0;
    const counting: CompletePositionsDeps = {
      rpc: {
        getLedgerEntries: async () => {
          reads++;
          return { latestLedger: 1, entries: [] };
        },
      },
      resolveWasmHash: registry,
    };
    expect(
      (await completePositionsFromLedger(result([stake]), "mainnet", counting)).positions
    ).toEqual([stake]);
    expect(reads).toBe(0);
  });

  test("a position already complete is not read again; one that cannot be read stays as reported", async () => {
    let reads = 0;
    const complete: SoroswapLpPosition = { ...soroswap, tokens: [TOKEN_0, TOKEN_1] };
    const counting: CompletePositionsDeps = {
      rpc: {
        getLedgerEntries: async () => {
          reads++;
          return { latestLedger: 1, entries: [] };
        },
      },
      resolveWasmHash: registry,
    };
    const untouched = await completePositionsFromLedger(result([complete]), "mainnet", counting);
    expect(untouched.positions).toEqual([complete]);
    expect(reads).toBe(0);
    const missing = await completePositionsFromLedger(result([aquarius]), "mainnet", counting);
    expect(missing.positions).toEqual([aquarius]);
    expect(reads).toBe(1);
  });

  test("a failing RPC or a malformed instance never throws; the positions come back as they were", async () => {
    const failing: CompletePositionsDeps = {
      rpc: {
        getLedgerEntries: async () => {
          throw new Error("rpc down");
        },
      },
      resolveWasmHash: registry,
    };
    const out = await completePositionsFromLedger(result([aquarius, soroswap]), "mainnet", failing);
    expect(out.positions).toEqual([aquarius, soroswap]);
    // Tokens that are not addresses are not tokens.
    const odd = contractInstanceEntry(AQ_POOL, CONSTANT_HASH, [
      [sym("TokenA"), xdr.ScVal.scvU32(1)],
      [sym("TokenB"), addr(AQUA_SAC)],
      [sym("TokenShare"), addr(AQ_SHARE)],
    ]);
    const partial = await completePositionsFromLedger(result([aquarius]), "mainnet", deps([odd]));
    expect(partial.positions[0]).toEqual({
      ...aquarius,
      shareToken: AQ_SHARE,
      poolType: "constant_product",
    });
  });

  test("reads are bounded: past the cap, positions stay as reported", async () => {
    const many = Array.from({ length: MAX_COMPLETION_READS + 5 }, (_, i) => ({
      ...soroswap,
      contractAddress: Address.contract(Buffer.alloc(32, i + 1)).toString(),
    }));
    let requested = 0;
    const counting: CompletePositionsDeps = {
      rpc: {
        getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
          requested = keys.length;
          return { latestLedger: 1, entries: [] };
        },
      },
      resolveWasmHash: registry,
    };
    await completePositionsFromLedger(result(many), "mainnet", counting);
    expect(requested).toBe(MAX_COMPLETION_READS);
  });
});
