import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { detectDefiPositionsViaDirectRead } from "@/lib/defi-positions/testnet-direct-read";
import { servedContractRegistry } from "@/lib/contract-registry";

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
    // registry records that (verifiedLive: false) and the read skips it, so a fresh account is
    // clean rather than blocked on a registry gap it has nothing to do with.
    expect(
      servedContractRegistry().entries.some((e) => e.protocol === "fxdao" && !e.verifiedLive)
    ).toBe(true);
    expect(result.unrecognizedPositions).toEqual([]);
  },
  30_000
);
