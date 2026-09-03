import { expect, test } from "bun:test";
import { Contract, scValToNative } from "@stellar/stellar-sdk";
import { entriesForNetwork, entriesForProtocol } from "@/lib/contract-registry";
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
      let live: string | null;
      try {
        live = await readLiveWasmHash(rpc, entry.address);
      } catch (err) {
        live = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
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

/** A contract's instance storage by the JSON form of each key. */
async function instanceStorage(contract: string): Promise<Map<string, unknown>> {
  const rpc = getRpcServer("mainnet");
  const response = await rpc.getLedgerEntries(new Contract(contract).getFootprint());
  const storage = new Map<string, unknown>();
  for (const entry of response.entries[0]?.val.contractData().val().instance().storage() ?? []) {
    storage.set(JSON.stringify(scValToNative(entry.key())), scValToNative(entry.val()));
  }
  return storage;
}

const hex = (value: unknown): string =>
  Buffer.from(value as Uint8Array | { data: number[] } as never).toString("hex");

test.skipIf(!RUN_INTEGRATION)(
  "the code the mainnet factories deploy today is the code the registry's representative pools run",
  async () => {
    // A registry that only re-reads its own representatives would stay green after a protocol
    // rotated its pool code: every new pool would run a hash the registry does not know, and
    // positions in them would be unexitable. So the deployers' current hashes are checked too.
    const aquariusRouter = entriesForProtocol("mainnet", "aquarius").find(
      (e) => e.kind === "router"
    )!;
    const router = await instanceStorage(aquariusRouter.address);
    const aquariusPools = entriesForProtocol("mainnet", "aquarius").filter(
      (e) => e.kind === "pool"
    );
    const byType = (version: string): string =>
      aquariusPools.find((e) => e.version === version)?.wasmHash ?? "missing";
    expect(hex(router.get('["ConstantPoolHash"]'))).toBe(byType("constant_product"));
    expect(hex(router.get('["StableSwapPoolHash"]'))).toBe(byType("stable"));
    expect(hex(router.get('["ConcentratedPoolHash"]'))).toBe(byType("concentrated"));

    for (const version of ["v1", "v2"]) {
      const blend = entriesForProtocol("mainnet", "blend").filter((e) => e.version === version);
      const factory = blend.find((e) => e.kind === "factory")!;
      const pool = blend.find((e) => e.kind === "pool")!;
      const meta = (await instanceStorage(factory.address)).get('"PoolMeta"') as {
        pool_hash: unknown;
      };
      expect(hex(meta.pool_hash)).toBe(pool.wasmHash ?? "missing");
    }
  },
  120_000
);
