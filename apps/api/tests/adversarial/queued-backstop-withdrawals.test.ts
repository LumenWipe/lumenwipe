/**
 * Adversarial coverage: queued backstop withdrawals (docs/architecture.md §17, issue #167).
 *
 * STUB HARNESS - see ./fixtures/exit-adapter-invariant-stub.ts for the full rationale. Blend's
 * backstop exit (epic #151: #152, #153, #154) does not exist in production code yet - backstop
 * share *detection* itself is explicitly unimplemented too (testnet-direct-read.ts's own header
 * comment states backstop shares are registered in the contract registry for provenance only,
 * never decoded). This file validates the Q4W (queue-for-withdrawal) cooldown invariant *logic*
 * against a minimal reference implementation of #153's own stated contract, not this tool's
 * actual behavior. It must be rewritten against the real exit adapter and the real #153 harness
 * once #154 lands - do not treat these tests as coverage of shipped behavior.
 */
import { test, expect } from "bun:test";
import {
  assessBackstopQueueInvariant,
  type StubBackstopShare,
} from "./fixtures/exit-adapter-invariant-stub";

const NOW = new Date("2026-09-02T00:00:00.000Z");
const COOLDOWN_SECONDS = 17 * 24 * 60 * 60; // Blend's Q4W cooldown is 17 days

function share(over: Partial<StubBackstopShare> = {}): StubBackstopShare {
  return {
    queuedForWithdrawalAt: null,
    cooldownSeconds: COOLDOWN_SECONDS,
    ...over,
  };
}

test("a share never queued for withdrawal cannot be assumed immediately exitable", () => {
  const blockers = assessBackstopQueueInvariant(share(), NOW);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.code).toBe("backstop_withdrawal_not_queued");
});

test("a share queued but still within its cooldown window is blocked", () => {
  const queuedAt = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
  const blockers = assessBackstopQueueInvariant(
    share({ queuedForWithdrawalAt: queuedAt.toISOString() }),
    NOW
  );
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.code).toBe("backstop_withdrawal_cooling_down");
  expect(blockers[0]!.message).toContain("second(s) remain");
});

test("a share queued exactly at the cooldown boundary is no longer blocked", () => {
  const queuedAt = new Date(NOW.getTime() - COOLDOWN_SECONDS * 1000);
  expect(
    assessBackstopQueueInvariant(share({ queuedForWithdrawalAt: queuedAt.toISOString() }), NOW)
  ).toEqual([]);
});

test("a share queued well past its cooldown is exitable", () => {
  const queuedAt = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  expect(
    assessBackstopQueueInvariant(share({ queuedForWithdrawalAt: queuedAt.toISOString() }), NOW)
  ).toEqual([]);
});
