/**
 * Completing an indexer's LP positions from the ledger: what OctoPos leaves out (an Aquarius
 * pool's tokens, share token, and code type; a Soroswap pair's tokens), read from the same
 * instance keys the testnet sweep decodes, and left alone whenever that read cannot be trusted.
 */
import { describe, expect, test } from "bun:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { AquariusLpPosition, DefiPositionsResult, SoroswapLpPosition } from "@lumenwipe/types";
import {
  MAX_COMPLETION_READS,
  completePositionsFromLedger,
  type CompletePositionsDeps,
} from "@/lib/defi-positions/complete-positions";
import type { ContractResolution } from "@/lib/contract-registry";
import { contractInstanceEntry, mockRpc } from "./fixtures/testnet-direct-read-helpers";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const AQ_POOL = "CCSY43EHJAHT3NQDYKAMJXRFBEEH7OXDL3J3VNGO33UUSEXWNN27GBIZ";
const AQ_SHARE = "CC4BPROIXISEFC7UKTB2HYBLNSNP27WNCR7YNZOHXLTPTGDKFMKYQ2YN";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const AQUA_SAC = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";
const PAIR = "CB46LMGJC7SYSH4C7SBNLV635OX5BSNQDGRR32NRXAV7N2AVNZMQUJ3A";
const TOKEN_0 = "CBCU5VMZ3GNHHKJUWZ2GI7K36MEAXOJW2RJCIJHFPVFGBME3WADLXA6W";
const TOKEN_1 = "CCBJNX4B23ZDXEE3KRS2IAQJSLNQY4ZJ24K44BI7FYYIF5ZAZMRYPRRD";
const CONSTANT_HASH = "ae0da5a84b15805c5c7931ac567a8d1b34be3f26b483993d9ff80cb2c3de9852";
const STABLE_HASH = "f1077e0b77da5e62d596e13aeae4160104cad99e7ef7f3183a6c9b6ec9e747cd";
const PAIR_HASH = "18051456816b66f12e773a56f77c5794fac1b1fb7ab6e22d4fad5a412770f73e";
const UNKNOWN_HASH = "9".repeat(64);

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

const aquarius: AquariusLpPosition = {
  protocol: "aquarius",
  positionType: "lp",
  contractAddress: AQ_POOL,
  shareAmount: "100",
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
  const known = (protocol: "aquarius" | "soroswap", kind: "pool" | "pair", version: string) =>
    ({ status: "known", protocol, kind, version, wasmHash: hash }) as const;
  if (hash === CONSTANT_HASH) return known("aquarius", "pool", "constant_product");
  if (hash === STABLE_HASH) return known("aquarius", "pool", "stable");
  if (hash === PAIR_HASH) return known("soroswap", "pair", "v1");
  return { status: "unknown", wasmHash: hash };
};

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
