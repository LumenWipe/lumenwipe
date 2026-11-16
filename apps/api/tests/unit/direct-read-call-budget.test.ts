import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import * as contractRegistry from "@/lib/contract-registry";
import { entriesForNetwork, type ContractRegistryEntry } from "@/lib/contract-registry";
import {
  aquariusTokensHash,
  detectDefiPositionsViaDirectRead,
  LEDGER_KEYS_PER_CALL,
  variantVal,
} from "@/lib/defi-positions/testnet-direct-read";
import {
  DEGRADED_SOURCE,
  DEGRADED_SOURCE_CONFIRMED,
  resolveDefiPositions,
} from "@/lib/defi-positions/resolve-defi-positions";
import {
  assessDefiPositionsGate,
  DEFI_POSITIONS_UNAVAILABLE_CODE,
} from "@/lib/defi-positions/positions-gate";
import {
  contractDataEntry,
  contractInstanceEntry,
  mockRpc,
  structVal,
} from "./fixtures/testnet-direct-read-helpers";
import { fakeRpcServer } from "../support/rpc-server";
import { fakeFetch } from "../support/fetch";

const USER = Keypair.random().publicKey();
const SOROSWAP_PAIRS = 221;
const AQUARIUS_SETS = 343;
const AQUARIUS_DOUBLE_SETS = 49;

const randomContract = (): string =>
  StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()));
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const sym = (s: string): xdr.ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
const u128 = (n: number): xdr.ScVal =>
  xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo: BigInt(n) }));

const MAINNET = entriesForNetwork("mainnet");
const only = (protocol: string, kind: string, version?: string): ContractRegistryEntry[] =>
  MAINNET.filter(
    (e) => e.protocol === protocol && e.kind === kind && (!version || e.version === version)
  );

/**
 * The bundled mainnet registry on a ledger shaped like mainnet's: every probed contract live on
 * its pinned code, every Phoenix pool naming a share token and its stake contract, a Soroswap
 * factory of 221 pairs and an Aquarius router of 343 token sets holding 392 pools. The account
 * holds nothing, so a sweep that completes confirms an empty result.
 */
function mainnetShapedLedger() {
  const entries = MAINNET.filter((e) => e.wasmHash !== null).map((e) => {
    if (e.protocol === "soroswap" && e.kind === "factory") {
      return contractInstanceEntry(e.address, e.wasmHash!, [
        [sym("TotalPairs"), xdr.ScVal.scvU32(SOROSWAP_PAIRS)],
      ]);
    }
    if (e.protocol === "aquarius" && e.kind === "router") {
      return contractInstanceEntry(e.address, e.wasmHash!, [
        [sym("TokensSetCounter"), u128(AQUARIUS_SETS)],
      ]);
    }
    return contractInstanceEntry(e.address, e.wasmHash!);
  });
  const stakes = only("phoenix", "stake");
  only("phoenix", "pool").forEach((pool, i) => {
    entries.push(
      contractDataEntry(
        pool.address,
        xdr.ScVal.scvSymbol("CONFIG"),
        structVal({
          share_token: addr(randomContract()),
          stake_contract: addr(stakes[i % stakes.length]!.address),
          token_a: addr(randomContract()),
          token_b: addr(randomContract()),
        })
      )
    );
  });
  const factory = only("soroswap", "factory")[0]!.address;
  for (let i = 0; i < SOROSWAP_PAIRS; i++) {
    entries.push(
      contractDataEntry(
        factory,
        variantVal("PairAddressesNIndexed", xdr.ScVal.scvU32(i)),
        addr(randomContract())
      )
    );
  }
  const router = only("aquarius", "router")[0]!.address;
  const poolHash = only("aquarius", "pool", "constant_product")[0]!.wasmHash!;
  for (let i = 0; i < AQUARIUS_SETS; i++) {
    const tokens = [randomContract(), randomContract()];
    const pools = Array.from({ length: i < AQUARIUS_DOUBLE_SETS ? 2 : 1 }, randomContract);
    entries.push(
      contractDataEntry(
        router,
        variantVal("TokensSet", u128(i)),
        xdr.ScVal.scvVec(tokens.map(addr))
      ),
      contractDataEntry(
        router,
        variantVal("TokensSetPools", xdr.ScVal.scvBytes(aquariusTokensHash(tokens))),
        xdr.ScVal.scvMap(
          pools.map(
            (pool, j) =>
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvBytes(Buffer.alloc(32, j + 1)),
                val: structVal({ address: addr(pool), pool_type: xdr.ScVal.scvU32(1) }),
              })
          )
        )
      ),
      ...pools.map((pool) =>
        contractInstanceEntry(pool, poolHash, [
          [sym("TokenA"), addr(tokens[0]!)],
          [sym("TokenB"), addr(tokens[1]!)],
          [sym("TokenShare"), addr(randomContract())],
        ])
      )
    );
  }
  return mockRpc(entries);
}

const rateLimited = (): Error =>
  Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });

/** Answers until `budget` calls have been made in this window, then refuses like a 429. */
function budgetedRpc(budget: number) {
  const inner = mainnetShapedLedger();
  const sizes: number[] = [];
  const rpc = fakeRpcServer({
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      sizes.push(keys.length);
      if (sizes.length > budget) throw rateLimited();
      return inner.getLedgerEntries(...keys);
    },
  });
  return { rpc, sizes };
}

const NOT_TRACKED = { positions: [], source: "not-tracked", timestamp: null, queryKeys: {} };

function resolveOnMainnet(rpc: ReturnType<typeof fakeRpcServer>) {
  return resolveDefiPositions(USER, "mainnet", {
    octopos: {
      baseUrl: "https://octopos.example",
      fetch: fakeFetch(() => new Response(JSON.stringify(NOT_TRACKED), { status: 200 })),
    },
    directRead: { rpc },
  });
}

beforeEach(() => {
  spyOn(contractRegistry, "isRegistryFresh").mockReturnValue(true);
});

afterEach(() => {
  mock.restore();
});

test("a mainnet-shaped sweep merges its reads into 16 calls, none above the key cap", async () => {
  const { rpc, sizes } = budgetedRpc(Infinity);
  const result = await detectDefiPositionsViaDirectRead(USER, "mainnet", { rpc });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([]);
  expect(sizes).toHaveLength(16);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(LEDGER_KEYS_PER_CALL);
  const pools = AQUARIUS_SETS + AQUARIUS_DOUBLE_SETS;
  const phoenix = only("phoenix", "pool").length;
  const blendPools = only("blend", "pool").length;
  const probed = MAINNET.filter(
    (e) =>
      !(e.kind === "pair" || (e.protocol === "aquarius" && e.kind === "pool")) &&
      !(
        (e.kind === "factory" || e.kind === "router") &&
        !(e.protocol === "soroswap" && e.kind === "factory") &&
        !(e.protocol === "aquarius" && e.kind === "router")
      )
  ).length;
  const backstopKeys = only("blend", "backstop").length + blendPools;
  const keys =
    probed +
    (2 * blendPools + backstopKeys + phoenix + 2) +
    (2 * phoenix + SOROSWAP_PAIRS + AQUARIUS_SETS) +
    (SOROSWAP_PAIRS + AQUARIUS_SETS) +
    pools +
    pools;
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(keys);
});

test("under a call budget the merged sweep completes and confirms the account", async () => {
  const { rpc, sizes } = budgetedRpc(20);
  const result = await resolveOnMainnet(rpc);
  expect(sizes.length).toBeLessThanOrEqual(20);
  expect(result.source).toBe(DEGRADED_SOURCE_CONFIRMED);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("a sweep refused partway degrades, and the positions gate still blocks", async () => {
  const { rpc, sizes } = budgetedRpc(8);
  const result = await resolveOnMainnet(rpc);
  expect(sizes.length).toBeGreaterThan(8);
  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.positions).toEqual([]);
  expect(result.timestamp).toBeNull();
  const blockers = assessDefiPositionsGate(result, new Date(), 0);
  expect(blockers.map((b) => b.code)).toContain(DEFI_POSITIONS_UNAVAILABLE_CODE);
});

test("a sweep whose first call is refused degrades without reporting anything", async () => {
  const { rpc, sizes } = budgetedRpc(0);
  const result = await resolveOnMainnet(rpc);
  expect(sizes).toHaveLength(1);
  expect(result.source).toBe(DEGRADED_SOURCE);
  expect(result.positions).toEqual([]);
  expect(assessDefiPositionsGate(result, new Date(), 0).map((b) => b.code)).toContain(
    DEFI_POSITIONS_UNAVAILABLE_CODE
  );
});
