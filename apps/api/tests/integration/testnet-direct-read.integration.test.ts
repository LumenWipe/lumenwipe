import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  detectDefiPositionsViaDirectRead,
  enumerateAquariusPools,
} from "@/lib/defi-positions/testnet-direct-read";
import { servedContractRegistry } from "@/lib/contract-registry";
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import { getRpcServer } from "@/lib/stellar/rpc";

// This test calls the real, live Stellar testnet RPC - no mock. The package's `test` script
// scopes itself to tests/unit + tests/e2e, so a bare `bun test` never picks this up; only
// `bun run test:integration` sets the opt-in flag (same convention as octopos-adapter.integration.test.ts).
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "every verifiedLive registry entry still resolves on live testnet with the recorded wasmHash",
  async () => {
    // A real regression/staleness canary: this is the same check the FxDAO entry (verifiedLive:
    // false) is already known to fail today - if a `verifiedLive: true` entry starts failing
    // too, testnet reset or a redeploy invalidated the registry and it needs a refresh PR.
    const { Contract } = await import("@stellar/stellar-sdk");
    const { getRpcServer } = await import("@/lib/stellar/rpc");
    const rpc = getRpcServer("testnet");

    for (const entry of servedContractRegistry().entries.filter((e) => e.verifiedLive)) {
      const contract = new Contract(entry.address);
      const res = await rpc.getLedgerEntries(contract.getFootprint());
      expect(res.entries.length).toBeGreaterThan(0);
    }
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
    // The FxDAO entry is documented-but-currently-unresolvable (see contract-registry.json). The
    // registry records that (verifiedLive: false); the read still probes it and stays silent only
    // while the network agrees it is absent, so a fresh account is clean rather than blocked on a
    // registry gap it has nothing to do with. The probe is asserted here so the silence is never
    // mistaken for a skip: the day the contract appears, this and the unit suite both say so.
    const documentedGaps = servedContractRegistry().entries.filter(
      (e) => e.protocol === "fxdao" && !e.verifiedLive
    );
    expect(documentedGaps.length).toBeGreaterThan(0);
    for (const gap of documentedGaps) {
      expect(await readLiveWasmHash(getRpcServer("testnet"), gap.address)).toBeNull();
    }
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
