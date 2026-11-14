import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  detectDefiPositionsViaDirectRead,
  enumerateAquariusPools,
} from "@/lib/defi-positions/testnet-direct-read";
import { codeMatchesEntry, servedContractRegistry } from "@/lib/contract-registry";
import { readLiveCodeIdentity } from "@/lib/stellar/contract-instance";
import { getRpcServer } from "@/lib/stellar/rpc";

// This test calls the real, live Stellar testnet RPC - no mock. The package's `test` script
// scopes itself to tests/unit + tests/e2e, so a bare `bun test` never picks this up; only
// `bun run test:integration` sets the opt-in flag (same convention as octopos-adapter.integration.test.ts).
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "every verifiedLive registry entry still runs its recorded code on live testnet, reached the recorded way",
  async () => {
    // A real regression/staleness canary: if a `verifiedLive: true` entry starts failing, testnet
    // reset or a redeploy invalidated the registry and it needs a refresh PR.
    const rpc = getRpcServer("testnet");

    // Testnet entries only. The registry gained mainnet entries in #195, and a mainnet contract
    // does not exist on testnet - so an unfiltered sweep asked the testnet RPC for addresses
    // that were never there and failed on the first one, reporting drift that was not drift.
    // Mainnet's own entries have their canary in mainnet-registry.integration.test.ts.
    const testnetEntries = servedContractRegistry().entries.filter(
      (e) => e.verifiedLive && e.network === "testnet"
    );
    expect(testnetEntries.length).toBeGreaterThan(0);
    const drifted: string[] = [];
    for (const entry of testnetEntries) {
      const live = await readLiveCodeIdentity(rpc, entry.address);
      if (live === null || !codeMatchesEntry(entry, live)) {
        drifted.push(`${entry.protocol} ${entry.kind} ${entry.address}: ${JSON.stringify(live)}`);
      }
    }
    expect(drifted).toEqual([]);
  },
  30_000
);

test.skipIf(!RUN_INTEGRATION)(
  "a fresh address with no positions returns a clean empty result, not an error",
  async () => {
    const address = Keypair.random().publicKey();
    const result = await detectDefiPositionsViaDirectRead(address);
    expect(result.address).toBe(address);
    expect(result.network).toBe("testnet");
    expect(Array.isArray(result.positions)).toBe(true);
    expect(result.positions).toEqual([]);
    expect(result.unrecognizedPositions).toEqual([]);
  },
  30_000
);

test.skipIf(!RUN_INTEGRATION)(
  "the Aquarius sweep enumerates the live router's pools, including the registry's representative pools",
  async () => {
    // A change in the router's storage shape must fail here loudly - the fresh-account sweep above
    // cannot tell "no pools decoded" from "this account holds nothing".
    const router = servedContractRegistry().entries.find(
      (e) => e.network === "testnet" && e.protocol === "aquarius" && e.kind === "router"
    );
    expect(router).toBeDefined();
    const flags: string[] = [];
    const pools = await enumerateAquariusPools(getRpcServer("testnet"), router!, (rawType) =>
      flags.push(rawType)
    );
    expect(flags).toEqual([]);
    expect(pools).not.toBeNull();
    expect(pools!.length).toBeGreaterThan(100);
    const addresses = new Set(pools!.map((p) => p.pool));
    for (const entry of servedContractRegistry().entries.filter(
      (e) => e.network === "testnet" && e.protocol === "aquarius" && e.kind === "pool"
    )) {
      expect(addresses.has(entry.address)).toBe(true);
    }
    const shareBased = pools!.filter((p) => p.shareToken !== null);
    expect(shareBased.length).toBeGreaterThan(0);
    expect(shareBased.every((p) => p.tokens !== null && p.tokens.length >= 2)).toBe(true);
  },
  60_000
);
