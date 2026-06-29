import { test, expect } from "bun:test";
import { loadAccountWithRetry } from "@/lib/playground/mess-builders";

// Reproduces the playground 502/504 bug: right after friendbot funds the demo
// account, the Soroban RPC has not yet ingested the ledger, so getAccount throws
// "Account not found". A single unguarded call surfaces as a failed mess step.
const ADDR = "GBOYVOCQNI34T7IO6RPNE6RZCVD7WNTFJZJUEX64RSQF6IJT5NFDRGMN";
const notFound = (addr: string) => new Error(`Account not found: ${addr}`);

test("retries while the account is not yet visible on RPC, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await loadAccountWithRetry(
    async (addr) => {
      calls++;
      if (calls < 3) throw notFound(addr);
      return { id: addr };
    },
    ADDR,
    { attempts: 6, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) }
  );
  expect(calls).toBe(3);
  expect(sleeps.length).toBe(2); // waited before the 2nd and 3rd attempt only
  expect(result.id).toBe(ADDR);
});

test("gives up after the attempt budget and rethrows the not-found error", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async (addr) => {
        calls++;
        throw notFound(addr);
      },
      ADDR,
      { attempts: 4, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/account not found/i);
  expect(calls).toBe(4);
});

test("does not retry unrelated errors", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async () => {
        calls++;
        throw new Error("network unreachable");
      },
      ADDR,
      { attempts: 5, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/network unreachable/);
  expect(calls).toBe(1);
});
