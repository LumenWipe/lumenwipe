/**
 * Soroban token discovery: candidates from every source are confirmed on the ledger, classic
 * assets and share tokens never appear, what could not be read is said, and no source failure
 * ever hides what another source found.
 */
import { describe, expect, test } from "bun:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type {
  AquariusLpPosition,
  BlendSupplyPosition,
  FxdaoCdpPosition,
  PhoenixLpPosition,
} from "@lumenwipe/types";
import {
  EVENTS_CHUNK_LEDGERS,
  EVENTS_PAGE_LIMIT,
  INDEXER_MAX_PAGES,
  INDEXER_PAGE_LIMIT,
  MAX_CANDIDATES,
  MAX_CANDIDATES_PER_SOURCE,
  defaultSorobanTokensDeps,
  discoverSorobanTokens,
} from "@/lib/stellar/soroban-tokens";
import {
  ACCOUNT,
  fakeSorobanDeps,
  indexerMovementsBody,
  type FakeToken,
} from "./fixtures/fake-soroban-tokens";
import { ARCHIVED } from "./fixtures/entry-archival";

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
  test("defaultSorobanTokensDeps disables the events scan unless a caller explicitly asks for it", () => {
    expect(defaultSorobanTokensDeps("mainnet", []).scanEvents).toBe(false);
    expect(defaultSorobanTokensDeps("mainnet", [], [], { scanEvents: true }).scanEvents).toBe(true);
  });

  test("no source reads a third-party indexer: the deps carry the RPC and nothing to fetch with", () => {
    const deps = defaultSorobanTokensDeps("mainnet", []);
    expect("fetch" in deps).toBe(false);
    expect("explorerBaseUrl" in deps).toBe(false);
  });

  test("merges lists, positions, and recent events into candidates, and reports only what the ledger confirms", async () => {
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
        events: {
          [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: {
            contracts: [NATIVE_A, SAC, SHARE, token(7)],
          },
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
        sources: ["events"],
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
      ["events:ok", "indexer:skipped", "list:ok", "manual:skipped", "positions:ok"].sort()
    );
    expect(result.eventsScanned).toEqual({
      fromLedger: LATEST - EVENTS_CHUNK_LEDGERS + 1,
      toLedger: LATEST,
    });
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
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => [t.contract, t.sources])).toEqual([[NATIVE_A, ["positions"]]]);
  });

  // The tokens of the real exits in apps/web/tests/unit/fixtures/real-exit-envelopes.ts, with the
  // credit older than the event window: the position itself is what names the token.
  describe("with nothing in the event window", () => {
    const PHOENIX_POOL = "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV";
    const PHOENIX_SHARE = "CC53IRMBHWTXE4BWPD5N4LH2L43YSYBMOFD6UARPMZBTWPSODFFKW2EG";
    const FXDAO_VAULT = "CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N";
    const FXDAO_USD = "CAEGVALLV7CA2SIFEDJNA52RKGUWRQWQXM5YNFUH7TH5G6X6QXMRQM4L";
    const phoenix: PhoenixLpPosition = {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      shareAmount: "388315",
      shareToken: PHOENIX_SHARE,
      usdValue: null,
    };
    const fxdao: FxdaoCdpPosition = {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: FXDAO_VAULT,
      denomination: "usd",
      collateralAmount: "199000000",
      debtAmount: "100000000",
      debtToken: FXDAO_USD,
      usdValue: null,
    };
    const quiet = (positions: Array<PhoenixLpPosition | FxdaoCdpPosition>, extra = {}) =>
      fakeSorobanDeps({
        world: {
          latestLedger: LATEST,
          tokens: [held(PHOENIX_SHARE, 388315n), held(FXDAO_USD, 100000000n)],
          events: { [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: [] } },
        },
        positions,
        ...extra,
      });

    test("an FxDAO vault's stablecoin is still confirmed on the ledger, through the position", async () => {
      const result = await discoverSorobanTokens(ACCOUNT, "testnet", quiet([fxdao]));
      expect(result.tokens.map((t) => [t.contract, t.balance, t.sources])).toEqual([
        [FXDAO_USD, "100000000", ["positions"]],
      ]);
    });

    test("a Phoenix share token is never a token to decide about, whoever proposes it", async () => {
      const proposedEverywhere = fakeSorobanDeps({
        world: {
          latestLedger: LATEST,
          tokens: [held(PHOENIX_SHARE, 388315n)],
          events: {
            [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: [PHOENIX_SHARE] },
          },
        },
        listCandidates: [PHOENIX_SHARE],
        manualCandidates: [PHOENIX_SHARE],
        positions: [phoenix],
      });
      for (const deps of [quiet([phoenix]), proposedEverywhere]) {
        const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
        expect(result.tokens).toEqual([]);
        expect(result.unreadable).toEqual([]);
      }
    });
  });

  test("the event scan asks for every credit shape - SEP-41 and Stellar-asset transfers, and mints - over one recent window", async () => {
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [] },
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
      [mint, "*", who],
    ]);
    // One window, not six: walking the rest cost ~17s against mainnet and is paid by every
    // account that has nothing to find. Anything older is what the manual path is for.
    expect(deps.rpc.eventRequests).toHaveLength(1);
  });

  test("a busy window is read page by page, and the pages stop at the chunk's edge: a cursor page carries no end ledger", async () => {
    const newest = `${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`;
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 1n), held(NATIVE_B, 2n), held(GHOST, 3n)],
        events: {
          [newest]: {
            // One full page of the same token, then a second page holding another token and,
            // past the edge, a third the scan must not take from here.
            contracts: [...Array<string>(EVENTS_PAGE_LIMIT).fill(NATIVE_A), NATIVE_B],
            spill: [GHOST],
          },
        },
      },
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    const forNewest = deps.rpc.eventRequests.filter(
      (r) =>
        r.startLedger === LATEST - EVENTS_CHUNK_LEDGERS + 1 ||
        r.cursor?.startsWith(`${LATEST - EVENTS_CHUNK_LEDGERS + 1}/`)
    );
    expect(forNewest).toHaveLength(2);
    expect(forNewest[1]!.cursor).toBe(`${LATEST - EVENTS_CHUNK_LEDGERS + 1}/${LATEST}/1000`);
    expect(result.tokens.map((t) => t.contract).sort()).toEqual([NATIVE_A, NATIVE_B].sort());
    // The window produced candidates, so the sweep stops there instead of walking five more:
    // this is a best-effort look for what the indexed sources missed, not a history audit.
    expect(result.eventsScanned).toEqual({
      fromLedger: LATEST - EVENTS_CHUNK_LEDGERS + 1,
      toLedger: LATEST,
    });
  });

  test("the event scan skipped on request: a close round re-confirms known balances, it does not go looking", async () => {
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [held(NATIVE_A, 5n)] },
      listCandidates: [NATIVE_A],
    });
    deps.scanEvents = false;
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(deps.rpc.eventRequests).toEqual([]);
    expect(result.coverage.find((c) => c.source === "events")).toEqual({
      source: "events",
      status: "skipped",
      detail: "not requested",
    });
    expect(result.eventsScanned).toBeNull();
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.warnings).toEqual([]);
  });

  test("a window the RPC refuses is a failed source with a readable reason, and costs nothing else", async () => {
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 1n)],
        events: {
          [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: {
            error: "[-32001] request exceeded processing limit threshold",
          },
        },
      },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    // What the other sources knew is still read and reported: only the search for MORE was lost.
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.eventsScanned).toBeNull();
    const events = result.coverage.find((c) => c.source === "events")!;
    expect(events.status).toBe("failed");
    expect(events.detail).toBe("[-32001] request exceeded processing limit threshold");
    // The RPC client rejects with a plain object; a detail that reads "[object Object]" is the
    // bug this asserts against, and it is shown to users inside an incomplete-scan warning.
    expect(events.detail).not.toContain("[object");
  });

  test("a failed event scan is a plain warning naming the source, never a hidden balance", async () => {
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 3n)],
        events: { [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { error: "socket hang up" } },
      },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.coverage.find((c) => c.source === "events")).toEqual({
      source: "events",
      status: "failed",
      detail: "socket hang up",
    });
    expect(result.warnings.map((w) => w.code)).toEqual(["soroban_tokens_partial"]);
    expect(result.warnings[0]!.message).toContain("(events)");
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

  test("a token whose entries are archived is held like a live one; one the ledger does not hold is not", async () => {
    const discover = (world: Parameters<typeof fakeSorobanDeps>[0]["world"]) =>
      discoverSorobanTokens(
        ACCOUNT,
        "testnet",
        fakeSorobanDeps({ world, listCandidates: [NATIVE_A] })
      );
    const live = await discover({ tokens: [held(NATIVE_A, 11n)] });
    expect(live.tokens.map((t) => t.balance)).toEqual(["11"]);
    for (const archival of ARCHIVED) {
      expect(await discover({ tokens: [held(NATIVE_A, 11n)], archival })).toEqual(live);
    }
    const absent = await discover({ tokens: [{ ...held(NATIVE_A, 11n), exists: false }] });
    expect(absent.tokens).toEqual([]);
  });

  test("the candidate cap keeps the user's own contracts first and says how many were left unchecked", async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => token(100 + i));
    const manual = token(200);
    const deps = fakeSorobanDeps({
      world: { tokens: [...many.map((c) => held(c, 1n)), held(manual, 2n)] },
      listCandidates: many,
      manualCandidates: [manual],
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

  test("a contract the user typed in that is not a Soroban token here is told back by name, never dropped in silence", async () => {
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 1n), { contract: SAC, isStellarAsset: true, balance: 9n }],
      },
      manualCandidates: [NATIVE_A, GHOST, SAC],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    const warning = result.warnings.find((w) => w.code === "soroban_tokens_manual_ignored");
    expect(warning?.message).toContain(`${GHOST.slice(0, 4)}…${GHOST.slice(-4)} is not a contract`);
    expect(warning?.message).toContain(`${SAC.slice(0, 4)}…${SAC.slice(-4)} is a Stellar asset's`);
    expect(result.unreadable).toEqual([]);
  });

  test("a symbol is shown only when it is plain printable text; anything else, and a decoder failure, read as none", async () => {
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [
          held(NATIVE_A, 1n, { symbol: "  OK  " }),
          held(NATIVE_B, 1n, { symbol: "bad\u0000\u0001name" }),
          held(GHOST, 1n, { symbol: "ünïcødé" }),
        ],
      },
      listCandidates: [NATIVE_A, NATIVE_B, GHOST],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    const symbolOf = (c: string): string | null | undefined =>
      result.tokens.find((t) => t.contract === c)?.symbol;
    expect(symbolOf(NATIVE_A)).toBe("OK");
    expect(symbolOf(NATIVE_B)).toBeNull();
    expect(symbolOf(GHOST)).toBeNull();
    expect(result.tokens).toHaveLength(3);
  });

  test("a position's own contract is never a held token, even when the event scan proposes it", async () => {
    const pair = token(9);
    const position = {
      protocol: "soroswap",
      type: "lp",
      contractAddress: pair,
      tokens: [NATIVE_A, NATIVE_B],
    } as unknown as AquariusLpPosition;
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(pair, 1n), held(NATIVE_A, 1n)],
        events: {
          [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: [pair, NATIVE_A] },
        },
      },
      positions: [position],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
  });

  test("one source cannot flood the candidates: the event scan contributes at most its per-source share", async () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_SOURCE + 10 }, (_, i) => token(100 + i));
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: many.map((c) => held(c, 1n)),
        events: { [`${LATEST - EVENTS_CHUNK_LEDGERS + 1}-${LATEST}`]: { contracts: many } },
      },
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toHaveLength(MAX_CANDIDATES_PER_SOURCE);
    expect(result.warnings.find((w) => w.code === "soroban_tokens_capped")).toBeUndefined();
  });

  test("when the sources spend the whole budget, the unprobed tokens are unreadable for that reason, not missing", async () => {
    const clock = { now: 1_700_000_000_000 };
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [held(NATIVE_A, 1n)] },
      listCandidates: [NATIVE_A],
      budgetMs: 1_000,
      clock,
    });
    const latest = deps.rpc.getHealth.bind(deps.rpc);
    deps.rpc.getHealth = async () => {
      clock.now += 2_000; // the event scan alone overran the budget
      return latest();
    };
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toEqual([]);
    expect(result.unreadable).toEqual([NATIVE_A]);
    expect(result.warnings.find((w) => w.code === "soroban_tokens_unreadable")?.message).toContain(
      `${NATIVE_A.slice(0, 4)}…${NATIVE_A.slice(-4)}`
    );
  });

  test("the event scan yields to the time budget instead of eating the analysis", async () => {
    const clock = { now: 1_700_000_000_000 };
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [held(NATIVE_A, 5n)] },
      listCandidates: [NATIVE_A],
      // LEDGER_READS_RESERVE_MS (6s) is held back for the balance reads, so a 5s budget leaves
      // the scan nothing at all - reading what the account holds outranks looking for more.
      budgetMs: 5_000,
      clock,
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(deps.rpc.eventRequests).toEqual([]);
    // The balance the other sources already knew about still comes back: a scan that ran out of
    // time degrades the search, it does not fail the analysis.
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    const events = result.coverage.find((c) => c.source === "events")!;
    expect(events.status).toBe("failed");
    expect(events.detail).toBe("time budget");
  });

  test("a position's payout token the account does not hold yet is listed with a zero balance and its metadata", async () => {
    const position = {
      protocol: "aquarius",
      type: "lp",
      contractAddress: token(20),
      tokens: [NATIVE_A, NATIVE_B],
    } as unknown as AquariusLpPosition;
    const deps = fakeSorobanDeps({
      world: {
        latestLedger: LATEST,
        tokens: [held(NATIVE_A, 0n, { symbol: "AAA", decimals: 7 }), held(NATIVE_B, 3n)],
      },
      listCandidates: [GHOST],
      positions: [position],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toEqual([
      { contract: NATIVE_A, balance: "0", symbol: "AAA", decimals: 7, sources: ["positions"] },
      { contract: NATIVE_B, balance: "3", symbol: "TKN", decimals: 7, sources: ["positions"] },
    ]);
  });

  test("an empty balance from any other source is not listed at all", async () => {
    const deps = fakeSorobanDeps({
      world: { latestLedger: LATEST, tokens: [held(NATIVE_A, 0n)] },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "testnet", deps);
    expect(result.tokens).toEqual([]);
  });
});

describe("the indexer source", () => {
  const fullPage = (cursor: string) =>
    indexerMovementsBody(Array<string>(INDEXER_PAGE_LIMIT).fill("native"), cursor);

  test("a token only the indexer knows is listed once the ledger confirms it, and nothing it names skips that read", async () => {
    const deps = fakeSorobanDeps({
      world: {
        tokens: [held(NATIVE_A, 5n), held(NATIVE_B, 9n), held(token(7), 0n)],
        indexer: [
          {
            status: 200,
            body: indexerMovementsBody(
              [
                NATIVE_B,
                NATIVE_A,
                token(7),
                GHOST,
                "native",
                "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              ],
              null
            ),
          },
        ],
      },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(Object.fromEntries(result.tokens.map((t) => [t.contract, t.sources]))).toEqual({
      [NATIVE_A]: ["list", "indexer"],
      [NATIVE_B]: ["indexer"],
    });
    expect(result.coverage).toContainEqual({ source: "indexer", status: "ok" });
    expect(result.warnings).toEqual([]);
    expect(deps.indexerCalls).toHaveLength(1);
    const url = new URL(deps.indexerCalls[0]!.url);
    expect(url.origin + url.pathname).toBe(`https://indexer.test/v1/accounts/${ACCOUNT}/movements`);
    expect(url.searchParams.get("direction")).toBe("received");
    expect(url.searchParams.get("limit")).toBe(String(INDEXER_PAGE_LIMIT));
    expect(deps.indexerCalls[0]!.authorization).toBe("Bearer sip_test");
  });

  test("it reads at most its page budget, following the cursor, and says older movements were left unread", async () => {
    const pages = Array.from({ length: INDEXER_MAX_PAGES + 2 }, (_, i) => ({
      status: 200,
      body:
        i === 1
          ? indexerMovementsBody(
              [NATIVE_B, ...Array<string>(INDEXER_PAGE_LIMIT - 1).fill("native")],
              `c${i}`
            )
          : fullPage(`c${i}`),
    }));
    const deps = fakeSorobanDeps({ world: { tokens: [held(NATIVE_B, 1n)], indexer: pages } });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(deps.indexerCalls).toHaveLength(INDEXER_MAX_PAGES);
    expect(new URL(deps.indexerCalls[0]!.url).searchParams.get("cursor")).toBeNull();
    expect(new URL(deps.indexerCalls[1]!.url).searchParams.get("cursor")).toBe("c0");
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_B]);
    expect(result.coverage).toContainEqual({
      source: "indexer",
      status: "ok",
      detail: `${INDEXER_MAX_PAGES} pages read; older movements were not`,
    });
    expect(result.warnings).toEqual([]);
  });

  test("a page that fails after the first keeps what the earlier pages proposed", async () => {
    const deps = fakeSorobanDeps({
      world: {
        tokens: [held(NATIVE_B, 1n)],
        indexer: [
          {
            status: 200,
            body: indexerMovementsBody(
              [NATIVE_B, ...Array<string>(INDEXER_PAGE_LIMIT - 1).fill("native")],
              "c0"
            ),
          },
          { status: 502, body: {} },
        ],
      },
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_B]);
    expect(result.coverage).toContainEqual({
      source: "indexer",
      status: "ok",
      detail: "stopped after 1 page(s): indexer responded 502",
    });
  });

  test("an indexer that fails, errors, or answers garbage changes only its own coverage entry", async () => {
    for (const answer of [
      { throws: "socket hang up" },
      { status: 503, body: {} },
      { status: 200, body: { data: { movements: "nope" } } },
    ]) {
      const deps = fakeSorobanDeps({
        world: { tokens: [held(NATIVE_A, 3n)], indexer: [answer] },
        listCandidates: [NATIVE_A],
      });
      const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
      expect(result.tokens.map((t) => [t.contract, t.sources])).toEqual([[NATIVE_A, ["list"]]]);
      expect(result.coverage.find((c) => c.source === "indexer")?.status).toBe("failed");
      expect(result.warnings).toEqual([]);
    }
  });

  test("its candidates rank last, so a flood from it cannot push out the other sources' under the cap", async () => {
    const flood = Array.from({ length: MAX_CANDIDATES_PER_SOURCE }, (_, i) => token(100 + i));
    const deps = fakeSorobanDeps({
      world: {
        tokens: [held(NATIVE_A, 2n)],
        indexer: [{ status: 200, body: indexerMovementsBody(flood, null) }],
      },
      listCandidates: [NATIVE_A],
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(result.tokens.map((t) => t.contract)).toEqual([NATIVE_A]);
    expect(result.warnings.map((w) => w.code)).toContain("soroban_tokens_capped");
  });

  test("an account the indexer has never seen proposes nothing and is not a failure", async () => {
    const deps = fakeSorobanDeps({
      world: { tokens: [], indexer: [{ status: 404, body: { title: "Not found" } }] },
    });
    const result = await discoverSorobanTokens(ACCOUNT, "mainnet", deps);
    expect(result.coverage).toContainEqual({ source: "indexer", status: "ok" });
    expect(result.tokens).toEqual([]);
  });

  test("the default deps use the indexer only with a key, per network, and never when a caller turns it off", () => {
    const saved = process.env.STELLARINDEX_API_KEY;
    try {
      delete process.env.STELLARINDEX_API_KEY;
      expect(defaultSorobanTokensDeps("mainnet", []).indexer).toBeNull();
      process.env.STELLARINDEX_API_KEY = " sip_abc ";
      expect(defaultSorobanTokensDeps("mainnet", []).indexer).toMatchObject({
        baseUrl: "https://api.stellarindex.io/v1",
        apiKey: "sip_abc",
      });
      expect(defaultSorobanTokensDeps("testnet", []).indexer?.baseUrl).toBe(
        "https://api.testnet.stellarindex.io/v1"
      );
      expect(defaultSorobanTokensDeps("mainnet", [], [], { useIndexer: false }).indexer).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.STELLARINDEX_API_KEY;
      else process.env.STELLARINDEX_API_KEY = saved;
    }
  });
});
