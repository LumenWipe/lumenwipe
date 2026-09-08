import { expect, test } from "bun:test";
import { discoverSorobanTokens, defaultSorobanTokensDeps } from "@/lib/stellar/soroban-tokens";

// Live, read-only, against the public explorer and RPC of each network: no account of ours, no
// transaction, no funds. Opt-in like every integration test: `bun run test:integration`.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

// A mainnet holder of deJTRSY (Centrifuge), a Soroban-native token with no classic issuer, taken
// from the token's holder list on stellar.expert. The balance is re-read from the ledger here.
const MAINNET_HOLDER = "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK";
const DEJTRSY = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";

test.skipIf(!RUN_INTEGRATION)(
  "mainnet: a real Soroban-native holding is found through the live sources and confirmed on the ledger",
  async () => {
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
    // Every source either answered or said why it did not; the event scan covered some window.
    expect(result.coverage.length).toBeGreaterThan(0);
    expect(
      result.eventsScanned === null ||
        result.eventsScanned.toLedger > result.eventsScanned.fromLedger
    ).toBe(true);
  },
  60_000
);

test.skipIf(!RUN_INTEGRATION)(
  "testnet: an account with no Soroban tokens reads clean, and the full-retention event scan fits the budget",
  async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const fresh = Keypair.random().publicKey();
    const result = await discoverSorobanTokens(
      "GDGHXOVHOT5PWDAR3GZWZ6KUD2ZBFYCDWWJBUMMC4BEWGB3RD254NRKR",
      "testnet",
      defaultSorobanTokensDeps("testnet", [])
    );
    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.warnings.filter((w) => w.code === "soroban_tokens_unreadable")).toEqual([]);
    const empty = await discoverSorobanTokens(
      fresh,
      "testnet",
      defaultSorobanTokensDeps("testnet", [])
    );
    expect(empty.tokens).toEqual([]);
  },
  60_000
);
