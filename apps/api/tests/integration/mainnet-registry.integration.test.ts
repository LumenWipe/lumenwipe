import { expect, test } from "bun:test";
import { entriesForNetwork } from "@/lib/contract-registry";
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import { getRpcServer } from "@/lib/stellar/rpc";

// Read-only against live mainnet RPC: no account, no transaction, no funds. Every verifiedLive
// mainnet entry must still run the code it was verified as, or exits on that protocol would halt
// at the registry gate (or, worse, a redeploy would be building against the wrong interface).
// Opt-in like every integration test: `bun run test:integration`.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "every verifiedLive mainnet registry entry still resolves on live mainnet with its recorded wasmHash",
  async () => {
    const rpc = getRpcServer("mainnet");
    const entries = entriesForNetwork("mainnet").filter((e) => e.verifiedLive);
    expect(entries.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const entry of entries) {
      const live = await readLiveWasmHash(rpc, entry.address);
      if (live !== entry.wasmHash) {
        mismatches.push(
          `${entry.protocol} ${entry.kind} ${entry.address}: live ${live}, registry ${entry.wasmHash}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  },
  120_000
);
