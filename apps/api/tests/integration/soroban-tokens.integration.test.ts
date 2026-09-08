import { expect, test } from "bun:test";
import {
  EVENTS_CHUNK_LEDGERS,
  EVENTS_MAX_CHUNKS,
  discoverSorobanTokens,
  defaultSorobanTokensDeps,
} from "@/lib/stellar/soroban-tokens";
import { STELLAR_EXPERT_API_URL } from "@/config/networks";

// Live, read-only, against the public explorer and RPC of each network: no account of ours, no
// transaction, no funds. Opt-in like every integration test: `bun run test:integration`.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

// A mainnet holder of deJTRSY (Centrifuge), a Soroban-native token with no classic issuer, taken
// from the token's holder list on stellar.expert. The balance is re-read from the ledger here.
const MAINNET_HOLDER = "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK";
const DEJTRSY = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";
// A testnet account of ours that has traded on the Soroswap testnet AMM.
const TESTNET_HOLDER = "GDGHXOVHOT5PWDAR3GZWZ6KUD2ZBFYCDWWJBUMMC4BEWGB3RD254NRKR";

/** Whether the explorer still lists the token for the holder; a third party moving its funds is
 *  not a failure of the code under test, so the mainnet case steps aside rather than fail. */
async function explorerStillLists(holder: string, contract: string): Promise<boolean> {
  const res = await fetch(`${STELLAR_EXPERT_API_URL}/explorer/public/account/${holder}/value`);
  if (!res.ok) return true; // unknown: run the test and let it speak
  const body = (await res.json()) as { balances?: Array<{ asset?: string; balance?: string }> };
  return (body.balances ?? []).some((b) => b.asset === contract && b.balance !== "0");
}

test.skipIf(!RUN_INTEGRATION)(
  "mainnet: a real Soroban-native holding is found through the live sources and confirmed on the ledger",
  async () => {
    if (!(await explorerStillLists(MAINNET_HOLDER, DEJTRSY))) {
      console.warn("mainnet holder no longer holds deJTRSY per the explorer; pick another holder");
      return;
    }
    const result = await discoverSorobanTokens(
      MAINNET_HOLDER,
      "mainnet",
      defaultSorobanTokensDeps("mainnet", [])
    );
    const found = result.tokens.find((t) => t.contract === DEJTRSY);
    expect(found, JSON.stringify(result.coverage)).toBeDefined();
    expect(BigInt(found!.balance)).toBeGreaterThan(0n);
    // deJTRSY is an 18-decimal token; what matters is that the contract answered.
    expect(found!.decimals).toBe(18);
    expect(found!.symbol).toBe("deJTRSY");
    // The explorer proposed it and the ledger confirmed it; the event scan covered a real window
    // (the public mainnet RPC's processing cap may stop it early, which is reported, not hidden).
    expect(found!.sources).toContain("explorer");
    expect(result.coverage.find((c) => c.source === "explorer")?.status).toBe("ok");
    expect(result.eventsScanned).not.toBeNull();
    expect(
      result.eventsScanned!.toLedger - result.eventsScanned!.fromLedger
    ).toBeGreaterThanOrEqual(EVENTS_CHUNK_LEDGERS - 1);
  },
  60_000
);

test.skipIf(!RUN_INTEGRATION)(
  "testnet: the full event scan fits the budget on the public RPC, and an account with no tokens reads clean",
  async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const result = await discoverSorobanTokens(
      TESTNET_HOLDER,
      "testnet",
      defaultSorobanTokensDeps("testnet", [])
    );
    expect(result.coverage.find((c) => c.source === "events")).toMatchObject({ status: "ok" });
    expect(result.coverage.find((c) => c.source === "events")?.detail).toBeUndefined();
    expect(result.eventsScanned!.toLedger - result.eventsScanned!.fromLedger + 1).toBe(
      EVENTS_MAX_CHUNKS * EVENTS_CHUNK_LEDGERS
    );
    expect(result.warnings.filter((w) => w.code === "soroban_tokens_unreadable")).toEqual([]);

    const empty = await discoverSorobanTokens(
      Keypair.random().publicKey(),
      "testnet",
      defaultSorobanTokensDeps("testnet", [])
    );
    expect(empty.tokens).toEqual([]);
    expect(empty.unreadable).toEqual([]);
  },
  60_000
);
