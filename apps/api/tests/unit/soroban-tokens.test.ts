/**
 * Soroban token discovery: candidates from every source are confirmed on the ledger, classic
 * assets and share tokens never appear, what could not be read is said, and no source failure
 * ever hides what another source found.
 */
import { describe, expect, test } from "bun:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { AquariusLpPosition, BlendSupplyPosition } from "@lumenwipe/types";
import {
  EVENTS_CHUNK_LEDGERS,
  EVENTS_MAX_CHUNKS,
  MAX_CANDIDATES,
  discoverSorobanTokens,
} from "@/lib/stellar/soroban-tokens";
import {
  ACCOUNT,
  explorerValueBody,
  fakeSorobanDeps,
  type FakeToken,
} from "./fixtures/fake-soroban-tokens";

const token = (n: number): string => Address.contract(Buffer.alloc(32, n)).toString();
const NATIVE_A = token(1);
const NATIVE_B = token(2);
const SAC = token(3);
const GHOST = token(4);
const BROKEN = token(5);
const SHARE = token(6);
const LATEST = 1_000_000;

const held = (contract: string, balance: bigint, over: Partial<FakeToken> = {}): FakeToken => ({
  contract,
  balance,
  symbol: "TKN",
  decimals: 7,
  ...over,
});

describe("Soroban token discovery", () => {
  test("merges the explorer, lists, positions, and recent events into candidates, and reports only what the ledger confirms", async () => {
    const position: AquariusLpPosition = {
      protocol: "aquarius",
      positionType: "lp",
      contractAddress: token(9),
      shareAmount: "1",
      usdValue: null,
      tokens: [NATIVE_B, SAC],
      shareToken: SHARE,
    };
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [
          held(NATIVE_A, 1_500_000n, { symbol: "ALPHA", decimals: 6 }),
          held(NATIVE_B, 42n),
          held(SAC, 10n, { isStellarAsset: true }),
          held(SHARE, 7n),
          { contract: GHOST, exists: false, balance: 1n },
          held(token(7), 0n),
        ],
        explorer: {
          status: 200,
          body: explorerValueBody([
            { contract: NATIVE_A, balance: "1500000" },
            { contract: SAC, balance: "10" },
            { contract: SHARE, balance: "7" },
          ]),
        },
        events: {
          [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: [NATIVE_A, token(7)] },
        },
      },
      listCandidates: [GHOST, NATIVE_B],
      positions: [position],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toEqual([
      {
        contract: NATIVE_A,
        balance: "1500000",
        symbol: "ALPHA",
        decimals: 6,
        sources: ["explorer", "events"],
      },
      {
        contract: NATIVE_B,
        balance: "42",
        symbol: "TKN",
        decimals: 7,
        sources: ["positions", "list"],
      },
    ]);
    // The share token is the position itself; the Stellar asset's balance is its trustline; the
    // ghost is not on the ledger; the empty one holds nothing. None is a token to decide about.
    expect(result.tokens.map((t) => t.contract)).not.toContain(SHARE);
    expect(result.unreadable).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.coverage.map((c) => `${c.source}:${c.status}`).sort()).toEqual(
      ["events:ok", "explorer:ok", "list:ok", "manual:skipped", "positions:ok"].sort()
    );
    expect(result.eventsScanned).toEqual({
      fromLedger: LATEST - EVENTS_MAX_CHUNKS * EVENTS_CHUNK_LEDGERS + 1,
      toLedger: LATEST,
    });
    expect(deps.explorerCalls[0]).toBe(
      `https://explorer.test/explorer/testnet/account/${ACCOUNT}/value`
    );
  });

  test("a Blend position's asset is a candidate too: the exit pays it out", async () => {
    const supply: BlendSupplyPosition = {
      protocol: "blend",
      positionType: "supply",
      contractAddress: token(9),
      assetAddress: NATIVE_A,
      bTokenAmount: "1",
      usdValue: null,
    };
    const deps = fakeSorobanDeps({
      world: { tokens: [held(NATIVE_A, 5n)] },
      positions: [supply],
      explorerBaseUrl: "",
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => [t.contract, t.sources])).toEqual([[NATIVE_A, ["positions"]]]);
  });

  test("the event scan asks for every credit shape - SEP-41 and Stellar-asset transfers, and mints - newest window first", async () => {
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [] },
      explorerBaseUrl: "",
    });
    await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    const first = deps.rpc.eventRequests[0]!;
    expect(first.endLedger).toBe(LATEST);
    expect(first.startLedger).toBe(LATEST - EVENTS_CHUNK_LEDGERS + 1);
    const who = new Address(ACCOUNT).toScVal().toXDR("base64");
    const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
    const mint = xdr.ScVal.scvSymbol("mint").toXDR("base64");
    expect(first.topics).toEqual([
      [transfer, "*", who],
      [transfer, "*", who, "*"],
      [mint, who],
      [mint, who, "*"],
    ]);
    expect(deps.rpc.eventRequests).toHaveLength(EVENTS_MAX_CHUNKS);
    expect(deps.rpc.eventRequests[1]!.endLedger).toBe(LATEST - EVENTS_CHUNK_LEDGERS);
  });

  test("a window the RPC refuses ends the scan: what was covered counts, the gap is reported, nothing else is lost", async () => {
    const secondStart = LATEST - 2 * EVENTS_CHUNK_LEDGERS + 1;
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 1n)],
        events: {
          [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: [NATIVE_A] },
          [`${secondStart}-${LATEST - EVENTS_CHUNK_LEDGERS}`]: {
            error: "request exceeded processing limit threshold",
          },
        },
      },
      explorerBaseUrl: "",
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.eventsScanned).toEqual({
      fromLedger: LATEST - EVENTS_CHUNK_LEDGERS + 1,
      toLedger: LATEST,
    });
    expect(result.coverage.find((c) => c.source === "events")).toEqual({
      source: "events",
      status: "ok",
      detail: "request exceeded processing limit threshold",
    });
    expect(deps.rpc.eventRequests).toHaveLength(2);
  });

  test("an explorer outage is a failed source and a plain warning, never a hidden balance", async () => {
    const deps = fakeSorobanDeps({
      world: { tokens: [held(NATIVE_A, 3n)], explorer: { throws: "socket hang up" } },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.coverage.find((c) => c.source === "explorer")).toEqual({
      source: "explorer",
      status: "failed",
      detail: "socket hang up",
    });
    expect(result.warnings.map((w) => w.code)).toEqual(["soroban_tokens_partial"]);
    expect(deps.explorerCalls[0]).toContain("/explorer/public/account/");
    // 404 (an account the explorer never indexed) proposes nothing and is not a failure.
    const unknown = fakeSorobanDeps({
      world: { tokens: [], explorer: { status: 404, body: { error: "not found" } } },
    });
    const none = await discoverSorobanTokens(ACCOUNT, "mainnet", unknown);
    expect(none.coverage.find((c) => c.source === "explorer")?.status).toBe("ok");
    expect(none.warnings).toEqual([]);
    // A 5xx is a failure.
    const down = fakeSorobanDeps({ world: { tokens: [], explorer: { status: 503, body: {} } } });
    expect(
      (await discoverSorobanTokens(ACCOUNT, "mainnet", down)).coverage.find(
        (c) => c.source === "explorer"
      )?.status
    ).toBe("failed");
  });

  test("a token that will not report a balance, or never answers, is unreadable and named in a warning", async () => {
    const deps = fakeSorobanDeps({
      world: {
        tokens: [
          { contract: BROKEN, balance: null },
          { contract: GHOST, balance: 1n, hangs: true },
          held(NATIVE_A, 9n),
        ],
      },
      listCandidates: [BROKEN, GHOST, NATIVE_A],
      explorerBaseUrl: "",
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.unreadable).toEqual([BROKEN, GHOST].sort());
    const warning = result.warnings.find((w) => w.code === "soroban_tokens_unreadable");
    expect(warning?.message).toContain("2 token contract(s)");
    expect(warning?.message).toContain(BROKEN.slice(0, 4));
  }, 15_000);

  test("a token without readable metadata is still held: symbol and decimals come back null", async () => {
    const deps = fakeSorobanDeps({
      world: { tokens: [held(NATIVE_A, 11n, { symbol: null, decimals: null })] },
      listCandidates: [NATIVE_A],
      explorerBaseUrl: "",
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens[0]).toEqual({
      contract: NATIVE_A,
      balance: "11",
      symbol: null,
      decimals: null,
      sources: ["list"],
    });
  });

  test("the candidate cap keeps the user's own contracts first and says how many were left unchecked", async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => token(100 + i));
    const manual = token(200);
    const deps = fakeSorobanDeps({
      world: { tokens: [...many.map((c) => held(c, 1n)), held(manual, 2n)] },
      listCandidates: many,
      manualCandidates: [manual],
      explorerBaseUrl: "",
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toHaveLength(MAX_CANDIDATES);
    expect(result.tokens.find((t) => t.contract === manual)?.sources).toEqual(["manual"]);
    expect(result.warnings.map((w) => w.code)).toEqual(["soroban_tokens_capped"]);
    expect(result.warnings[0]!.message).toContain("6 possible token contract(s)");
  });

  test("malformed candidates are ignored, and the RPC failing to serve the instances is a loud warning, not an empty result", async () => {
    const deps = fakeSorobanDeps({
      world: { tokens: [held(NATIVE_A, 1n)] },
      listCandidates: [
        "not-a-contract",
        "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG",
        NATIVE_A,
      ],
      explorerBaseUrl: "",
    });
    deps.rpc.getLedgerEntries = async () => {
      throw new Error("rpc down");
    };
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toEqual([]);
    expect(result.unreadable).toEqual([NATIVE_A]);
    expect(result.warnings.map((w) => w.code)).toEqual(["soroban_tokens_unreadable"]);
    expect(result.warnings[0]!.message).toContain("rpc down");
  });

  test("the event scan yields to the time budget and reports the window it did cover", async () => {
    const clock = { now: 1_700_000_000_000 };
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [] },
      explorerBaseUrl: "",
      budgetMs: 6_500,
      clock,
    });
    const original = deps.rpc.getEvents;
    deps.rpc.getEvents = async (request) => {
      clock.now += 400; // each chunk costs 400 ms of a 500 ms events budget
      return original(request);
    };
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(deps.rpc.eventRequests).toHaveLength(2);
    expect(result.eventsScanned).toEqual({
      fromLedger: LATEST - 2 * EVENTS_CHUNK_LEDGERS + 1,
      toLedger: LATEST,
    });
    expect(result.coverage.find((c) => c.source === "events")?.detail).toBe("time budget");
  });
});
