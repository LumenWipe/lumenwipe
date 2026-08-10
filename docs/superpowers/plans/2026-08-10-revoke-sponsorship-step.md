# REVOKE_SPONSORSHIP Step + Reserve-Affordability Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unconditional "this account sponsors N entries, must revoke all first" hard blocker with a real `REVOKE_SPONSORSHIP` transaction step, gated per-owner on whether that owner's account can absorb the shifted reserve — resolving GitHub issue [#72](https://github.com/LumenWipe/lumenwipe/issues/72).

**Architecture:** A new pure op-builder (`tx-builder/sponsorship.ts`) constructs one `Operation.revoke*Sponsorship` per `SponsoredEntry` kind. A new async module (`sponsorship-affordability.ts`) does the one piece of I/O this feature needs — reading each distinct sponsored owner's live reserve numbers — and is called once at plan time (to decide steps vs. blockers) and again at transaction-build time (the "live re-read before build" invariant, reusing the exact same function). `buildPlan` stays a pure, synchronous function: the affordability result is computed by the caller and passed in as a plain value. Claimable-balance sponsorships are a protocol-level dead end (see Global Constraints) and are excluded from the whole revoke path, always surfacing as their own explanatory blocker.

**Tech Stack:** NestJS (API), Next.js (web), `@stellar/stellar-sdk` 16.0.1, Bun test.

## Global Constraints

- Strict TypeScript, no `any`; explicit return types on exported functions (CONTRIBUTING.md).
- Prettier: double quotes, semicolons, printWidth 100.
- Comments only when the *why* is non-obvious (CLAUDE.md).
- `apps/api`'s transaction builder must stay a pure module: state in, unsigned envelopes out, no network I/O (CLAUDE.md hard invariant). All network reads for this feature live in `sponsorship-affordability.ts`, called by controllers/build-transactions, never by `buildPlan` or the op builders.
- The API re-reads exact on-chain state immediately before building — never build from stale/indexer data alone (CLAUDE.md hard invariant, and this issue's explicit "live re-read before build" task).
- **Protocol fact that overrides a literal reading of the issue's task list:** per CAP-33, `RevokeSponsorshipOp` on a `CLAIMABLE_BALANCE` ledger entry fails with `REVOKE_SPONSORSHIP_ONLY_TRANSFERABLE` unless a cooperating new sponsor is sandwiched around it via `BeginSponsoringFutureReserves`/`EndSponsoringFutureReserves` in the same transaction. This app has no such cooperating third party for a self-service close. Building a bare `revokeClaimableBalanceSponsorship` op here would therefore be a transaction that is *guaranteed* to fail on submission — worse than today's blanket blocker, and a violation of "never build a transaction the network is expected to reject." **Decision: `kind: "claimable_balance"` entries in `sponsoredEntries` are never converted into a `REVOKE_SPONSORSHIP` step. They always surface as their own permanent, distinctly-worded blocker**, regardless of affordability. The op-builder function still implements `revokeClaimableBalanceSponsorship` for completeness/testability, but no caller in this plan ever passes it a claimable-balance entry. Flag this explicitly to the second reviewer the issue asks for.
- **Trust-anchor invariant this plan depends on and must not weaken:** `apps/web/lib/stellar/verify.ts`'s `normalizeOp` (in `apps/web/lib/stellar/intent/serialize.ts`) must never learn to recognize `beginSponsoringFutureReserves` / `endSponsoringFutureReserves`. Left unrecognized, those ops decode to `{ type: "unknown" }`, and `assertCloseIntent`'s existing `case "unknown": throw` already rejects any transaction containing one. This is what makes a revoke op's reserve transfer structurally provable as "back to the entry's own owner, never a third party" — CAP-33's only other transition ("change sponsor") requires exactly that bracket. Do not add cases for those two op types anywhere in this plan.
- `apps/web/types/{account,plan,close-api}.ts` are pre-existing, tracked duplicates of `packages/types/src/*` (epic #68 flags this technical debt but permits filing the dedup separately). This plan follows the existing precedent (used by every prior field addition, e.g. `ClaimableBalanceSelection`) of mirroring new fields into both copies by hand, rather than doing the dedup refactor as an unplanned scope expansion.
- Reserve-mult-per-kind (how many base reserves a revoke shifts) must come from one source of truth: `RESERVES_PER_ENTRY` in `apps/api/src/lib/stellar/sponsorship-reconcile.ts`, already vetted in #71/PR #90. Export it; do not redeclare the numbers elsewhere.
- Decision granularity is **per owner, not per entry**: an owner's *total* shifted reserve (summed across every entry of theirs we sponsor) must be affordable for any of that owner's entries to become steps. This avoids leaving one owner in a half-revoked state within a single build. Document this explicitly — the issue's blocker-message wording is phrased per-entry, so blockers are still emitted per-entry (for a clear UI list) even though the underlying affordable/unaffordable decision is computed once per owner.

---

## File Structure

New files:
- `apps/api/src/lib/stellar/sponsorship-affordability.ts` — the one async I/O module (reused at plan time and build time).
- `apps/api/src/lib/stellar/tx-builder/sponsorship.ts` — pure op builder, one `Operation.revoke*Sponsorship` per `SponsoredEntry` kind.
- `apps/api/tests/unit/sponsorship-affordability.test.ts`
- `apps/api/tests/unit/tx-builder-sponsorship.test.ts`
- `apps/web/tests/unit/verify-revoke-sponsorship.test.ts` (kept separate from the large existing `verify.test.ts` so the new attack-scenario tests are easy to find in review).

Modified files (grouped by concern):
- **Types (single source):** `packages/types/src/plan.ts`, `packages/types/src/close-api.ts`.
- **API sponsorship internals (extend #71's data, don't duplicate its network calls):** `apps/api/src/lib/stellar/sponsorship-reconcile.ts`, `apps/api/src/lib/stellar/sponsorship.ts`.
- **API transaction building:** `apps/api/src/lib/stellar/tx-builder/index.ts`, `apps/api/src/lib/stellar/tx-builder/fused-close.ts`, `apps/api/src/lib/close-api/build-transactions.ts`, `apps/api/src/close/close.controller.ts`.
- **API misc:** `apps/api/src/lib/stellar/intent/serialize.ts`, `apps/api/src/lib/utils/errors.ts`.
- **API tests:** `apps/api/tests/unit/buildPlan.test.ts`, `apps/api/tests/unit/fused-close.test.ts` (or wherever `assembleFusedCloseOpsTagged` is tested — verify exact filename in Task 6).
- **Web type mirrors:** `apps/web/types/account.ts`, `apps/web/types/plan.ts`, `apps/web/types/close-api.ts`.
- **Web trust anchor:** `apps/web/lib/stellar/intent/serialize.ts`, `apps/web/lib/stellar/verify.ts`.
- **Web UI:** `apps/web/lib/utils/stepIcons.tsx`, `apps/web/components/plan/PlanAccordion.tsx`, `apps/web/lib/utils/errors.ts`.
- **Docs:** `docs/architecture.md` §3 (currently documents `ACCOUNT_MERGE_IS_SPONSOR` as "detect and block" — this issue is the fix).

---

## Task 1: Types — `REVOKE_SPONSORSHIP` step and `revoke_sponsorship` intent operation

**Files:**
- Modify: `packages/types/src/plan.ts`
- Modify: `packages/types/src/close-api.ts`

**Interfaces:**
- Produces: `StepType` now includes `"REVOKE_SPONSORSHIP"`. `IntentOperation` now includes a `revoke_sponsorship` variant every later task's `normalizeOp`/`verify()` work consumes.

- [ ] **Step 1: Add the step type**

In `packages/types/src/plan.ts`, add to the `StepType` union (placement: right after `"NORMALIZE_SIGNERS"`, matching the operation-order this plan uses in the builder):

```ts
export type StepType =
  | "NORMALIZE_SIGNERS"
  | "REVOKE_SPONSORSHIP"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "ADD_TRUSTLINE_FOR_CLAIM"
  | "CLAIM_BALANCES"
  | "CONVERT_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "CLOSE_ACCOUNT"
  | "MERGE";
```

- [ ] **Step 2: Add the intent operation variant**

In `packages/types/src/close-api.ts`, add to the `IntentOperation` union. Only the safety-relevant fields are included — see Task 9 for why `owner` + `entryKind` is sufficient for verification (the op's own structure makes redirecting reserve to a third party structurally impossible, given the Global Constraints invariant that begin/end-sponsoring ops stay unrecognized):

```ts
export type IntentOperation =
  | {
      type: "path_payment_strict_send";
      sendAsset: string;
      sendAmount: string;
      destination: string;
      destAsset: string;
      destMin: string;
      path: string[];
    }
  | { type: "payment"; destination: string; asset: string; amount: string }
  | { type: "change_trust"; asset: string; limit: string }
  | { type: "account_merge"; destination: string }
  | { type: "manage_sell_offer"; offerId: string; amount: string }
  | { type: "manage_data"; name: string; value: string | null }
  | { type: "set_options"; summary: string }
  | { type: "claim_claimable_balance"; balanceId: string }
  | {
      type: "revoke_sponsorship";
      entryKind: "account" | "trustline" | "offer" | "data_entry" | "signer";
      owner: string;
    };
```

- [ ] **Step 3: Type-check the packages**

Run: `bun run --filter '@lumenwipe/types' type-check`
Expected: passes (this file has no logic, just a union widening — every existing switch on `IntentOperation`/`StepType` elsewhere is non-exhaustive `switch`/`case` with a `default`, so nothing breaks yet; Tasks 5, 6, 9, 10 add the new cases).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/plan.ts packages/types/src/close-api.ts
git commit -m "feat(types): add revoke_sponsorship step and intent operation"
```

---

## Task 2: Export the reserve-mult table and extend owner live-state with reserve fields

This task extends #71's already-fetched Horizon account resource to also carry the four numbers the affordability check needs (balance, subentry count, num_sponsoring, num_sponsored) — zero extra network calls, since `fetchOwnerLiveState` already fetches `${base}/accounts/${owner}` for the sponsor-field checks.

**Files:**
- Modify: `apps/api/src/lib/stellar/sponsorship-reconcile.ts`
- Modify: `apps/api/src/lib/stellar/sponsorship.ts`
- Test: `apps/api/tests/unit/sponsorship-reconcile.test.ts` (existing file — add cases, don't replace)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RESERVES_PER_ENTRY` (exported, was module-private). `OwnerLiveState.reserve: { balanceLumens: string; numSubEntries: number; numSponsoring: number; numSponsored: number } | null`. `fetchOwnerLiveState` (exported, was module-private) — Task 3 calls it directly for a known, bounded set of owners without re-running Phase-1 discovery.

- [ ] **Step 1: Export `RESERVES_PER_ENTRY` and extend `OwnerLiveState`**

In `apps/api/src/lib/stellar/sponsorship-reconcile.ts`:

```ts
// was: const RESERVES_PER_ENTRY: Record<...>
export const RESERVES_PER_ENTRY: Record<Exclude<SponsoredEntry["kind"], "claimable_balance">, number> = {
  account: 2,
  trustline: 1,
  offer: 1,
  data_entry: 1,
  signer: 1,
};
```

Add to `OwnerLiveState`:

```ts
export interface OwnerLiveState {
  accountSponsor: string | null;
  trustlineSponsors: Record<string, string | null>;
  signerSponsors: Record<string, string | null>;
  offerSponsors: Record<string, string | null>;
  dataSponsors: Record<string, string | null>;
  fetchFailed: boolean;
  /** This owner's live reserve numbers, straight off the same Horizon-compatible account
   *  resource already fetched for the sponsor-field checks above - null when that fetch
   *  failed (fetchFailed is the source of truth for "don't trust anything else on this
   *  object"), never a placeholder zero. */
  reserve: { balanceLumens: string; numSubEntries: number; numSponsoring: number; numSponsored: number } | null;
}
```

- [ ] **Step 2: Populate `reserve` and export `fetchOwnerLiveState` in `sponsorship.ts`**

Extend `HorizonAccountForSponsorship` (in `apps/api/src/lib/stellar/sponsorship.ts`):

```ts
interface HorizonAccountForSponsorship {
  sponsor?: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance?: string;
    sponsor?: string;
  }>;
  signers: Array<{ key: string; sponsor?: string }>;
}
```

In `fetchOwnerLiveState`, right after `const account = (await accountRes.json()) as HorizonAccountForSponsorship;`, compute the native balance and build the `reserve` object:

```ts
const nativeBalance = account.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
const reserve = {
  balanceLumens: nativeBalance,
  numSubEntries: account.subentry_count,
  numSponsoring: account.num_sponsoring ?? 0,
  numSponsored: account.num_sponsored ?? 0,
};
```

Thread `reserve` into every return statement in `fetchOwnerLiveState` that currently returns a full (non-`empty`) state (the success path at the end of the function) — use `reserve` there, and use `null` in every early-return/`empty`-based path (404 short-circuit, non-OK, catch blocks), matching how those paths already treat every other field as untrustworthy. The 404 case (owner account gone) is a real "no reserve to check" case, not a failure — set `reserve: null` there too, since there's nothing left to be affordable about.

Change the function declaration from `async function fetchOwnerLiveState` to `export async function fetchOwnerLiveState`.

- [ ] **Step 3: Extend the existing reconcile test file with a `reserve` assertion**

In `apps/api/tests/unit/sponsorship-reconcile.test.ts`, `OwnerLiveState` test fixtures currently omit `reserve` — TypeScript will now error on every literal missing the field. Add `reserve: null` (or a realistic value for tests that care) to every `OwnerLiveState` object literal in that file. This is a mechanical fixup, not new test logic — the existing assertions are unaffected by `reserve`.

- [ ] **Step 4: Run the reconcile tests**

Run: `cd apps/api && bun test tests/unit/sponsorship-reconcile.test.ts`
Expected: all pass (mechanical fixup only; no behavior change to `reconcileSponsoredEntries`).

- [ ] **Step 5: Type-check and commit**

Run: `bun run --filter '@lumenwipe/api' type-check`
Expected: passes.

```bash
git add apps/api/src/lib/stellar/sponsorship-reconcile.ts apps/api/src/lib/stellar/sponsorship.ts apps/api/tests/unit/sponsorship-reconcile.test.ts
git commit -m "refactor(api): expose owner reserve state from sponsorship enumeration"
```

---

## Task 3: `sponsorship-affordability.ts` — the one async module

This is the single reused function: called once at plan time (decide steps vs. blockers) and again at build time (the live re-read invariant), both times against the exact set of owners the caller cares about — never re-running #71's expensive Phase-1 operations-history scan.

**Files:**
- Create: `apps/api/src/lib/stellar/sponsorship-affordability.ts`
- Test: `apps/api/tests/unit/sponsorship-affordability.test.ts`

**Interfaces:**
- Consumes: `fetchOwnerLiveState` and `RESERVES_PER_ENTRY` from Task 2. `SponsoredEntry` from `@lumenwipe/types`. `BASE_RESERVE_XLM` from `@/config/constants`.
- Produces: `SponsorshipAffordability { revocable: SponsoredEntry[]; unaffordableOwners: Map<string, { entries: SponsoredEntry[]; shortfallXlm: string }> }` and `assessSponsorshipAffordability(entries, network): Promise<SponsorshipAffordability>` — consumed by Tasks 5 (plan-time) and 7 (build-time).

- [ ] **Step 1: Write the failing test for the affordable case**

```ts
// apps/api/tests/unit/sponsorship-affordability.test.ts
import { test, expect, mock } from "bun:test";
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import type { SponsoredEntry } from "@lumenwipe/types";

const OWNER = "GBOWNER00000000000000000000000000000000000000000000000AAAA";

mock.module("@/lib/stellar/sponsorship", () => ({
  fetchOwnerLiveState: mock(async (owner: string) => {
    if (owner !== OWNER) throw new Error(`unexpected owner ${owner}`);
    return {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": OWNER === owner ? "GSPONSOR00000000000000000000000000000000000000000000000AAAA" : null },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: { balanceLumens: "10.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    };
  }),
}));

test("assessSponsorshipAffordability › owner with enough spendable balance → entry is revocable", async () => {
  const entries: SponsoredEntry[] = [
    { kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" },
  ];
  const result = await assessSponsorshipAffordability(entries, "testnet");
  expect(result.revocable).toEqual(entries);
  expect(result.unaffordableOwners.size).toBe(0);
});
```

Note: use `bun:test`'s `mock.module` to stub `fetchOwnerLiveState` rather than hitting a real Horizon-compatible endpoint — mirrors how `sponsorship-reconcile.test.ts` tests pure logic in isolation from network I/O. `SPONSOR` field in `trustlineSponsors` must equal `OWNER`'s current sponsor for the *closing* account under test — adjust the fixture's sponsor address to match whatever address you pass as the closing account in the real signature (see Step 3 below; the closing account's own address is not actually a parameter of this function — see the note in Step 3 about why).

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && bun test tests/unit/sponsorship-affordability.test.ts`
Expected: FAIL — `Cannot find module '@/lib/stellar/sponsorship-affordability'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/lib/stellar/sponsorship-affordability.ts
import type { Network } from "@/config/networks";
import { BASE_RESERVE_XLM } from "@/config/constants";
import { fetchOwnerLiveState } from "@/lib/stellar/sponsorship";
import { RESERVES_PER_ENTRY } from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

export interface SponsorshipAffordability {
  /** Entries confirmed still live-sponsored by the caller and whose owner can absorb the
   *  shifted reserve. Safe to build a REVOKE_SPONSORSHIP op for. */
  revocable: SponsoredEntry[];
  /** owner address -> the entries this owner cannot yet absorb, plus how much more XLM
   *  the owner needs. Never includes claimable_balance entries (excluded by callers -
   *  see the CAP-33 note in tx-builder/index.ts). */
  unaffordableOwners: Map<string, { entries: SponsoredEntry[]; shortfallXlm: string }>;
}

function entryOwner(entry: Exclude<SponsoredEntry, { kind: "claimable_balance" }>): string {
  return entry.owner;
}

function currentSponsorFor(
  live: NonNullable<Awaited<ReturnType<typeof fetchOwnerLiveState>>>,
  entry: Exclude<SponsoredEntry, { kind: "claimable_balance" }>
): string | null {
  switch (entry.kind) {
    case "account":
      return live.accountSponsor;
    case "trustline":
      return live.trustlineSponsors[entry.asset] ?? null;
    case "offer":
      return live.offerSponsors[entry.offerId] ?? null;
    case "data_entry":
      return live.dataSponsors[entry.name] ?? null;
    case "signer":
      return live.signerSponsors[entry.signerKey] ?? null;
  }
}

/**
 * Re-reads each distinct owner's live sponsorship + reserve state and decides, per owner,
 * whether revoking every entry this account still sponsors for them leaves the owner at or
 * above its minimum balance. Doubles as the "live re-read before build" check: an entry no
 * longer live-sponsored by `address` (resolved by someone else, or the owner vanished) is
 * silently dropped from both `revocable` and `unaffordableOwners` - it needs no operation.
 *
 * Decision granularity is per owner, not per entry: an owner's entries are all-revocable or
 * all-blocked together, based on the owner's TOTAL shifted reserve, so a build never leaves
 * one owner half-resolved. Excludes claimable_balance entries entirely - callers must filter
 * those out before calling (see the CAP-33 note in tx-builder/index.ts for why).
 */
export async function assessSponsorshipAffordability(
  address: string,
  entries: SponsoredEntry[],
  network: Network
): Promise<SponsorshipAffordability> {
  const byOwner = new Map<string, Exclude<SponsoredEntry, { kind: "claimable_balance" }>[]>();
  for (const entry of entries) {
    if (entry.kind === "claimable_balance") continue;
    const list = byOwner.get(entry.owner) ?? [];
    list.push(entry);
    byOwner.set(entry.owner, list);
  }

  const revocable: SponsoredEntry[] = [];
  const unaffordableOwners: SponsorshipAffordability["unaffordableOwners"] = new Map();

  const owners = Array.from(byOwner.keys());
  const liveStates = await Promise.all(owners.map((owner) => fetchOwnerLiveState(owner, network)));

  owners.forEach((owner, i) => {
    const ownerEntries = byOwner.get(owner)!;
    const live = liveStates[i];
    if (live.fetchFailed || live.reserve === null) return; // can't verify - drop silently, matches "unknown, don't guess"

    const stillSponsored = ownerEntries.filter((e) => currentSponsorFor(live, e) === address);
    if (stillSponsored.length === 0) return; // fully resolved already

    const totalMult = stillSponsored.reduce((sum, e) => sum + RESERVES_PER_ENTRY[e.kind], 0);
    const currentMinBalance =
      (2 + live.reserve.numSubEntries + live.reserve.numSponsoring - live.reserve.numSponsored) *
      BASE_RESERVE_XLM;
    const availableBalance = Number(live.reserve.balanceLumens) - currentMinBalance;
    const neededXlm = totalMult * BASE_RESERVE_XLM;

    if (availableBalance >= neededXlm) {
      revocable.push(...stillSponsored);
    } else {
      unaffordableOwners.set(owner, {
        entries: stillSponsored,
        shortfallXlm: (neededXlm - availableBalance).toFixed(7),
      });
    }
  });

  return { revocable, unaffordableOwners };
}
```

Note on the `entryOwner` helper: it's declared but unused in the snippet above except implicitly via `entry.owner` inline — remove it if your editor flags it as dead code; it was scaffolding for an earlier draft and `entry.owner` is used directly. (Delete this note and the helper together during implementation — keep the file clean.)

- [ ] **Step 4: Run it to see it pass**

Run: `cd apps/api && bun test tests/unit/sponsorship-affordability.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the unaffordable, mixed, and stale-entry cases**

Append to the same test file:

```ts
test("assessSponsorshipAffordability › owner without enough spendable balance → entry is unaffordable with a shortfall", async () => {
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async () => ({
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": "GSPONSOR00000000000000000000000000000000000000000000000AAAA" },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      // balance covers the base 2 reserves and its own subentry, but not the shifted one
      reserve: { balanceLumens: "1.5000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    })),
  }));
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.get(OWNER)?.entries).toEqual(entries);
  expect(Number(result.unaffordableOwners.get(OWNER)?.shortfallXlm)).toBeGreaterThan(0);
});

test("assessSponsorshipAffordability › entry no longer live-sponsored by us → dropped silently, no step, no blocker", async () => {
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async () => ({
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": "GSOMEONEELSE0000000000000000000000000000000000000000000AAAA" },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: { balanceLumens: "10.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    })),
  }));
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › mixed owners → affordable owner's entries revocable, unaffordable owner's entries blocked", async () => {
  const OWNER_B = "GBOWNERB0000000000000000000000000000000000000000000000AAAA";
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async (owner: string) =>
      owner === OWNER
        ? {
            accountSponsor: null,
            trustlineSponsors: { "USDC:GISSUER": "GSPONSOR00000000000000000000000000000000000000000000000AAAA" },
            signerSponsors: {},
            offerSponsors: {},
            dataSponsors: {},
            fetchFailed: false,
            reserve: { balanceLumens: "10.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
          }
        : {
            accountSponsor: null,
            trustlineSponsors: { "USDC:GISSUER": "GSPONSOR00000000000000000000000000000000000000000000000AAAA" },
            signerSponsors: {},
            offerSponsors: {},
            dataSponsors: {},
            fetchFailed: false,
            reserve: { balanceLumens: "1.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
          }
    ),
  }));
  const entries: SponsoredEntry[] = [
    { kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" },
    { kind: "trustline", owner: OWNER_B, asset: "USDC:GISSUER" },
  ];
  const result = await assessSponsorshipAffordability(entries, "testnet");
  expect(result.revocable).toEqual([entries[0]]);
  expect(result.unaffordableOwners.has(OWNER_B)).toBe(true);
  expect(result.unaffordableOwners.has(OWNER)).toBe(false);
});
```

Note: the mocked closing account address (`address` passed to `assessSponsorshipAffordability` in every call above) must be `"GSPONSOR00000000000000000000000000000000000000000000000AAAA"` for the sponsor field to match — pass that as the first argument in every call in this file, and define it as a `const SPONSOR = "GSPONSOR...";` at the top instead of inlining. Fix the Step 1 test to use the same constant.

- [ ] **Step 6: Run all four tests, confirm pass**

Run: `cd apps/api && bun test tests/unit/sponsorship-affordability.test.ts`
Expected: 4 pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/stellar/sponsorship-affordability.ts apps/api/tests/unit/sponsorship-affordability.test.ts
git commit -m "feat(api): compute per-owner reserve affordability for sponsorship revocation"
```

---

## Task 4: `tx-builder/sponsorship.ts` — the pure op builder

**Files:**
- Create: `apps/api/src/lib/stellar/tx-builder/sponsorship.ts`
- Test: `apps/api/tests/unit/tx-builder-sponsorship.test.ts`

**Interfaces:**
- Consumes: `assetToSdkAsset` from `@/lib/utils/assets`. `SponsoredEntry` from `@lumenwipe/types`.
- Produces: `revokeSponsorshipOps(entries: SponsoredEntry[]): xdr.Operation[]` — consumed by Task 6 (`fused-close.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/unit/tx-builder-sponsorship.test.ts
import { test, expect } from "bun:test";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";
import type { SponsoredEntry } from "@lumenwipe/types";

const OWNER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const SIGNER_KP = Keypair.random();

test("revokeSponsorshipOps › builds one op per non-claimable-balance kind", () => {
  const entries: SponsoredEntry[] = [
    { kind: "account", owner: OWNER },
    { kind: "trustline", owner: OWNER, asset: `USDC:${ISSUER}` },
    { kind: "offer", owner: OWNER, offerId: "12345" },
    { kind: "data_entry", owner: OWNER, name: "foo" },
    { kind: "signer", owner: OWNER, signerKey: SIGNER_KP.publicKey() },
  ];
  const ops = revokeSponsorshipOps(entries);
  expect(ops).toHaveLength(5);
  const decoded = ops.map((op) => Operation.fromXDRObject(op));
  expect(decoded.map((d) => d.type)).toEqual([
    "revokeAccountSponsorship",
    "revokeTrustlineSponsorship",
    "revokeOfferSponsorship",
    "revokeDataSponsorship",
    "revokeSignerSponsorship",
  ]);
});

test("revokeSponsorshipOps › claimable_balance entries never produce an op (CAP-33: unrevocable without a new sponsor)", () => {
  const entries: SponsoredEntry[] = [{ kind: "claimable_balance", balanceId: "00000000" + "ab".repeat(32) }];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (ed25519)", () => {
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: SIGNER_KP.publicKey() }];
  const decoded = Operation.fromXDRObject(revokeSponsorshipOps(entries)[0]);
  expect(decoded.type).toBe("revokeSignerSponsorship");
  // @ts-expect-error - narrow for the assertion only
  expect(decoded.signer.ed25519PublicKey).toBe(SIGNER_KP.publicKey());
});

test("revokeSponsorshipOps › unrecognized signer key type is skipped, not thrown", () => {
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: "not-a-real-key" }];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/api && bun test tests/unit/tx-builder-sponsorship.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/lib/stellar/tx-builder/sponsorship.ts
import { Operation, StrKey, xdr } from "@stellar/stellar-sdk";
import type { SponsoredEntry } from "@lumenwipe/types";
import { assetToSdkAsset } from "@/lib/utils/assets";

// Dispatches by StrKey prefix/decode success, exactly like signers.ts's signerRemovalOp -
// SponsoredEntry only carries the raw key string (no separate `type` field), so the type
// must be inferred the same way an inbound StrKey address is classified anywhere else in
// this codebase. Returns null (never throws) for a key type the SDK can't build a revoke
// op for, matching signerRemovalOp's "skip, don't fail the batch" precedent.
function revokeSignerSponsorshipOp(owner: string, signerKey: string): xdr.Operation | null {
  if (StrKey.isValidEd25519PublicKey(signerKey)) {
    return Operation.revokeSignerSponsorship({ account: owner, signer: { ed25519PublicKey: signerKey } });
  }
  if (StrKey.isValidSignedPayload(signerKey)) {
    return Operation.revokeSignerSponsorship({ account: owner, signer: { ed25519SignedPayload: signerKey } });
  }
  try {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { preAuthTx: StrKey.decodePreAuthTx(signerKey) },
    });
  } catch {
    // not a preAuthTx key
  }
  try {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { sha256Hash: StrKey.decodeSha256Hash(signerKey) },
    });
  } catch {
    // not a sha256Hash key either - unrecognized type
  }
  return null;
}

/**
 * Builds one Operation.revoke*Sponsorship per entry, transferring each entry's reserve
 * burden back to its own owning account (CAP-33's "stop sponsoring" transition - the only
 * transition this app ever performs; see the trust-anchor note in verify.ts for why no
 * BeginSponsoringFutureReserves bracket ever accompanies these ops).
 *
 * claimable_balance entries are silently skipped: CAP-33 requires a cooperating new sponsor
 * to revoke a claimable balance's sponsorship (REVOKE_SPONSORSHIP_ONLY_TRANSFERABLE otherwise),
 * which this self-service close flow can never arrange. Callers must never route a
 * claimable_balance entry into a REVOKE_SPONSORSHIP step in the first place - it stays a
 * permanent blocker (see tx-builder/index.ts) - but this function stays total and harmless
 * either way rather than throwing on a caller mistake.
 */
export function revokeSponsorshipOps(entries: SponsoredEntry[]): xdr.Operation[] {
  const ops: xdr.Operation[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "account":
        ops.push(Operation.revokeAccountSponsorship({ account: entry.owner }));
        break;
      case "trustline":
        ops.push(
          Operation.revokeTrustlineSponsorship({
            account: entry.owner,
            asset: assetToSdkAsset(entry.asset),
          })
        );
        break;
      case "offer":
        ops.push(Operation.revokeOfferSponsorship({ seller: entry.owner, offerId: entry.offerId }));
        break;
      case "data_entry":
        ops.push(Operation.revokeDataSponsorship({ account: entry.owner, name: entry.name }));
        break;
      case "signer": {
        const op = revokeSignerSponsorshipOp(entry.owner, entry.signerKey);
        if (op) ops.push(op);
        break;
      }
      case "claimable_balance":
        break;
    }
  }
  return ops;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd apps/api && bun test tests/unit/tx-builder-sponsorship.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/stellar/tx-builder/sponsorship.ts apps/api/tests/unit/tx-builder-sponsorship.test.ts
git commit -m "feat(api): build revoke-sponsorship operations per entry kind"
```

---

## Task 5: Wire affordability into `buildPlan` (blockers + steps + fast-path gate)

This is the reproduction test the issue names explicitly: unconditional blocker regardless of affordability is the bug; this task fixes it.

**Files:**
- Modify: `apps/api/src/lib/stellar/tx-builder/index.ts`
- Modify: `apps/api/tests/unit/buildPlan.test.ts`

**Interfaces:**
- Consumes: `SponsorshipAffordability` type from Task 3.
- Produces: `buildPlan`'s new optional 5th parameter `sponsorshipAffordability: SponsorshipAffordability`, defaulted so every existing call site (including every other test file) keeps compiling unchanged.

- [ ] **Step 1: Write the failing tests (the issue's acceptance criteria, verbatim)**

Add to `apps/api/tests/unit/buildPlan.test.ts` (import `SponsoredEntry` alongside the existing type imports):

```ts
const SPONSORED_OWNER = Keypair.random().publicKey();

test("buildPlan › affordable sponsored entry → REVOKE_SPONSORSHIP step, no sponsoring blocker", () => {
  const entry: SponsoredEntry = { kind: "trustline", owner: SPONSORED_OWNER, asset: `USDC:${ISSUER}` };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(account, false, false, {}, {
    revocable: [entry],
    unaffordableOwners: new Map(),
  });
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(true);
  expect(blockers.some((b) => b.message.toLowerCase().includes("sponsor"))).toBe(false);
});

test("buildPlan › unaffordable sponsored entry → per-owner blocker, no REVOKE_SPONSORSHIP step", () => {
  const entry: SponsoredEntry = { kind: "trustline", owner: SPONSORED_OWNER, asset: `USDC:${ISSUER}` };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(account, false, false, {}, {
    revocable: [],
    unaffordableOwners: new Map([[SPONSORED_OWNER, { entries: [entry], shortfallXlm: "0.5000000" }]]),
  });
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.message.includes("0.5000000"))).toBe(true);
});

test("buildPlan › mixed affordable + unaffordable owners → partial resolution, not all-or-nothing", () => {
  const affordableOwner = Keypair.random().publicKey();
  const affordableEntry: SponsoredEntry = { kind: "trustline", owner: affordableOwner, asset: `USDC:${ISSUER}` };
  const unaffordableEntry: SponsoredEntry = { kind: "signer", owner: SPONSORED_OWNER, signerKey: Keypair.random().publicKey() };
  const account = makeAccount({
    numSponsoring: 2,
    sponsoredEntries: [affordableEntry, unaffordableEntry],
  });
  const { steps, blockers } = buildPlan(account, false, false, {}, {
    revocable: [affordableEntry],
    unaffordableOwners: new Map([[SPONSORED_OWNER, { entries: [unaffordableEntry], shortfallXlm: "0.5000000" }]]),
  });
  const revokeStep = steps.find((s) => s.type === "REVOKE_SPONSORSHIP");
  expect(revokeStep?.operationCount).toBe(1); // only the affordable one
  expect(blockers).toHaveLength(1);
});

test("buildPlan › sponsorshipEnumerationIncomplete → old blanket blocker, ignores affordability result", () => {
  const entry: SponsoredEntry = { kind: "trustline", owner: SPONSORED_OWNER, asset: `USDC:${ISSUER}` };
  const account = makeAccount({
    numSponsoring: 1,
    sponsoredEntries: [entry],
    sponsorshipEnumerationIncomplete: true,
  });
  const { steps, blockers } = buildPlan(account, false, false, {}, {
    revocable: [entry], // even though the caller says it's affordable, incompleteness wins
    unaffordableOwners: new Map(),
  });
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.message.includes("sponsoring 1 entr"))).toBe(true);
});

test("buildPlan › claimable-balance sponsorship is always a permanent blocker, never a step", () => {
  const entry: SponsoredEntry = { kind: "claimable_balance", balanceId: "00000000" + "ab".repeat(32) };
  const account = makeAccount({ numSponsoring: 1, sponsoredEntries: [entry] });
  const { steps, blockers } = buildPlan(account, false, false, {}, {
    revocable: [],
    unaffordableOwners: new Map(),
  });
  expect(steps.some((s) => s.type === "REVOKE_SPONSORSHIP")).toBe(false);
  expect(blockers.some((b) => b.code === "sponsorship_claimable_balance_unrevocable")).toBe(true);
});

test("buildPlan › numSponsoring > 0 but no entries found (defensive fallback) → old blanket blocker", () => {
  // Existing behavior preserved: a numSponsoring/sponsoredEntries disagreement even when
  // enumeration claims complete must never silently resolve to "nothing to do."
  const { blockers } = buildPlan(makeAccount({ numSponsoring: 2 }), false);
  expect(blockers.some((b) => b.message.includes("sponsoring"))).toBe(true);
});
```

Also add `sponsoredEntries`/`sponsorshipEnumerationIncomplete` overrides support to `makeAccount` if not already present (it already is, per the file's current fixture — confirm `SponsoredEntry` is imported).

- [ ] **Step 2: Run to see the new tests fail**

Run: `cd apps/api && bun test tests/unit/buildPlan.test.ts`
Expected: FAIL — `buildPlan` doesn't accept a 5th argument yet; the old unconditional blocker still fires for the "affordable" case.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/stellar/tx-builder/index.ts`:

Add the import and the type:

```ts
import type {
  AccountState,
  ClaimableBalanceSelection,
  PlannedStep,
  StepType,
  BuildPlanResult,
  PlanBlocker,
  SponsoredEntry,
} from "@lumenwipe/types";
import type { SponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
```

Change the `buildPlan` signature:

```ts
export function buildPlan(
  accountState: AccountState,
  mediatorRequired: boolean,
  fastPathEligible = false,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection> = {},
  sponsorshipAffordability: SponsorshipAffordability = { revocable: [], unaffordableOwners: new Map() }
): BuildPlanResult {
```

Add a short local helper near the top of the file (module scope, alongside `step`):

```ts
function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function describeSponsoredEntry(entry: SponsoredEntry): string {
  switch (entry.kind) {
    case "account":
      return "an account creation";
    case "trustline":
      return `a trustline for ${entry.asset.split(":")[0]}`;
    case "offer":
      return `offer ${entry.offerId}`;
    case "data_entry":
      return `data entry "${entry.name}"`;
    case "signer":
      return "a signer";
    case "claimable_balance":
      return "a claimable balance";
  }
}
```

Replace the existing sponsoring blocker block:

```ts
// Sponsoring blocker: numSponsoring > 0 means this account is the reserve sponsor for
// entries on other accounts (including claimable balances it created). stellar-core
// refuses ACCOUNT_MERGE when numSponsoring > 0.
if (accountState.numSponsoring > 0) {
  blockers.push({
    message:
      `This account is sponsoring ${accountState.numSponsoring} entr${accountState.numSponsoring === 1 ? "y" : "ies"} ` +
      `on other accounts. All sponsorships must be revoked before the account can be merged.`,
  });
}
```

with:

```ts
// Sponsoring: numSponsoring > 0 means this account is the reserve sponsor for entries on
// other accounts. Per-owner affordability (computed by the caller via
// assessSponsorshipAffordability, since it requires a live on-chain read) decides step vs.
// blocker for each owner - this is the actual fix for the bug this replaces (an unconditional
// blocker regardless of whether the sponsored owner could actually absorb the reserve).
//
// Falls back to the old blanket blocker whenever the enumeration behind sponsoredEntries is
// admittedly incomplete (no partial resolution against a list that might be missing entries),
// or - defensively - whenever numSponsoring disagrees with what was actually enumerated (an
// enumeration bug should never silently read as "sponsors nothing").
const noEntriesFound = accountState.sponsoredEntries.length === 0;
if (accountState.numSponsoring > 0 && (accountState.sponsorshipEnumerationIncomplete || noEntriesFound)) {
  blockers.push({
    message:
      `This account is sponsoring ${accountState.numSponsoring} entr${accountState.numSponsoring === 1 ? "y" : "ies"} ` +
      `on other accounts. All sponsorships must be revoked before the account can be merged.`,
  });
} else {
  // Claimable balances can never be self-revoked (CAP-33 requires a cooperating new
  // sponsor this close flow cannot arrange) - always a permanent blocker, independent of
  // affordability.
  for (const entry of accountState.sponsoredEntries) {
    if (entry.kind !== "claimable_balance") continue;
    blockers.push({
      code: "sponsorship_claimable_balance_unrevocable",
      message:
        "This account sponsors a claimable balance, which cannot be revoked without a " +
        "cooperating new sponsor. It resolves automatically once a claimant claims the " +
        "balance - there is no self-service action to take here.",
    });
  }
  for (const [owner, info] of sponsorshipAffordability.unaffordableOwners) {
    for (const entry of info.entries) {
      blockers.push({
        code: "sponsorship_unaffordable",
        message:
          `Revoking sponsorship of ${describeSponsoredEntry(entry)} on ${shortAddr(owner)} would ` +
          `leave that account below its minimum balance - it needs ${info.shortfallXlm} more XLM first.`,
      });
    }
  }
}
```

Add the step-generation block right after the `NORMALIZE_SIGNERS` step push (before the `REMOVE_DATA_ENTRIES` block):

```ts
if (sponsorshipAffordability.revocable.length > 0) {
  const batches = batchItems(sponsorshipAffordability.revocable, OP_BATCH_LIMIT);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    steps.push(
      step(
        idx++,
        "REVOKE_SPONSORSHIP",
        batches.length > 1
          ? `Revoke sponsorships (batch ${i + 1}/${batches.length})`
          : "Revoke sponsorships",
        `Transfer reserve responsibility for ${batch.length} sponsored entr${batch.length === 1 ? "y" : "ies"} back to their own accounts.`,
        batch.length
      )
    );
  }
}
```

Finally, exclude any account with sponsored entries from the fast path (mirrors the existing claimable-balance exclusion) — add to the fast-path `if` condition:

```ts
if (
  fastPathEligible &&
  hasCleanup &&
  !hasHardBlocker &&
  balancesNeedingClaimStep.length === 0 &&
  accountState.sponsoredEntries.length === 0 &&
  fusedOpCount <= OP_BATCH_LIMIT
) {
```

- [ ] **Step 4: Run the full test file**

Run: `cd apps/api && bun test tests/unit/buildPlan.test.ts`
Expected: all pass, including every pre-existing test (the new parameter is optional and defaults to the empty/no-op affordability result, so untouched call sites behave exactly as before).

- [ ] **Step 5: Type-check and run the whole api unit suite**

Run: `bun run --filter '@lumenwipe/api' type-check && cd apps/api && bun test tests/unit`
Expected: all green — confirms no other test file's `makeAccount`/`buildPlan` call sites broke.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/stellar/tx-builder/index.ts apps/api/tests/unit/buildPlan.test.ts
git commit -m "fix(api): gate sponsorship revocation on per-owner reserve affordability"
```

---

## Task 6: Wire the op into the real transaction assembler (`fused-close.ts`)

Recall from investigation: `build-transactions.ts` always builds through `assembleFusedCloseOpsTagged`/`FusedCloseInput` (a single ordered, tagged op list, batched by raw operation count) — this is the actual transaction-construction path, independent of `buildPlan`'s preview/estimate step list.

**Files:**
- Modify: `apps/api/src/lib/stellar/tx-builder/fused-close.ts`
- Test: find and modify the existing test file covering `assembleFusedCloseOpsTagged` (search `grep -rl assembleFusedCloseOpsTagged apps/api/tests`)

**Interfaces:**
- Consumes: `revokeSponsorshipOps` from Task 4.
- Produces: `FusedCloseInput.revokeSponsorshipEntries: SponsoredEntry[]` — consumed by Task 7 (`build-transactions.ts`).

- [ ] **Step 1: Locate the existing test file**

Run: `grep -rl "assembleFusedCloseOpsTagged" apps/api/tests`

Read it to match its exact fixture-building conventions before writing new cases.

- [ ] **Step 2: Write the failing test**

Add a case following that file's existing style, asserting: given a non-empty `revokeSponsorshipEntries`, the tagged output contains ops tagged `"REVOKE_SPONSORSHIP"`, and their count matches `revokeSponsorshipOps(entries).length`; given an empty array, no such tag appears; ordering: `REVOKE_SPONSORSHIP`-tagged ops appear before `REMOVE_DATA_ENTRIES`-tagged ops (mirrors the placement decided in Task 5's plan-step ordering, for UI/mental-model consistency between the preview and the real build).

- [ ] **Step 3: Implement**

In `apps/api/src/lib/stellar/tx-builder/fused-close.ts`:

```ts
import type {
  AccountSigner,
  ClaimableBalance,
  ConversionPath,
  DataEntry,
  OpenOffer,
  SponsoredEntry,
  StepType,
  Trustline,
} from "@lumenwipe/types";
import { signerNormalizationOps } from "./signers";
import { revokeSponsorshipOps } from "./sponsorship";
```

Add to `FusedCloseInput`:

```ts
export interface FusedCloseInput {
  needsSignerNormalization: boolean;
  signers: AccountSigner[];
  /** Entries confirmed affordable AND still live-sponsored by this account immediately
   *  before build (see sponsorship-affordability.ts) - never includes claimable_balance
   *  entries, which can never be self-revoked (see the CAP-33 note where this is built). */
  revokeSponsorshipEntries: SponsoredEntry[];
  dataEntries: DataEntry[];
  openOffers: OpenOffer[];
  claimableBalances: ClaimableBalance[];
  trustlinesToAddForClaim: ClaimableBalance[];
  assetActions: AssetAction[];
  trustlines: Trustline[];
  destinationAddress: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  includeMerge: boolean;
}
```

In `assembleFusedCloseOpsTagged`, add right after the `needsSignerNormalization` block:

```ts
if (input.needsSignerNormalization) {
  push("NORMALIZE_SIGNERS", signerNormalizationOps(input.signers, masterKey));
}
push("REVOKE_SPONSORSHIP", revokeSponsorshipOps(input.revokeSponsorshipEntries));
push("REMOVE_DATA_ENTRIES", dataEntryRemovalOps(input.dataEntries));
```

Update the function's doc comment to mention the new fixed-order stage.

- [ ] **Step 4: Run the test**

Run: `cd apps/api && bun test <the file located in Step 1>`
Expected: new cases pass; every pre-existing case in that file now needs `revokeSponsorshipEntries: []` added to its `FusedCloseInput` fixtures (mechanical fixup — TypeScript will point at every missing-property error).

- [ ] **Step 5: Fix every other `FusedCloseInput` fixture across the API test suite**

Run: `grep -rl "FusedCloseInput\|needsSignerNormalization: " apps/api/tests apps/api/src --include="*.ts"`

Add `revokeSponsorshipEntries: []` to every object literal that constructs a `FusedCloseInput` and isn't part of this task's own new tests (`step-engine.ts`'s `CLOSE_ACCOUNT` branch in Task 7 also constructs one — handled there).

- [ ] **Step 6: Run the full api test suite and type-check**

Run: `bun run --filter '@lumenwipe/api' type-check && cd apps/api && bun test tests/unit tests/e2e`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/stellar/tx-builder/fused-close.ts apps/api/tests
git commit -m "feat(api): assemble revoke-sponsorship operations into the close transaction"
```

---

## Task 7: Live re-read before build + wiring into `build-transactions.ts`, `close.controller.ts`, `step-engine.ts`

**Files:**
- Modify: `apps/api/src/lib/close-api/build-transactions.ts`
- Modify: `apps/api/src/close/close.controller.ts`
- Modify: `apps/api/src/lib/stellar/step-engine.ts` (its `FusedCloseInput` literal in the `CLOSE_ACCOUNT` branch needs `revokeSponsorshipEntries: []` too — this branch never emits sponsorship revocation itself, since accounts with sponsored entries are excluded from the fast path per Task 5)
- Test: `apps/api/tests/unit/buildCloseTransactionsClaimable.test.ts` or wherever `buildCloseTransactions` is tested (add a case) — locate via `grep -rl buildCloseTransactions apps/api/tests`

**Interfaces:**
- Consumes: `assessSponsorshipAffordability` from Task 3.
- Produces: nothing new downstream — this is the final wiring point.

- [ ] **Step 1: Wire `close.controller.ts`'s `plan()` handler**

In `apps/api/src/close/close.controller.ts`, import `assessSponsorshipAffordability`, then in the `plan()` method, compute it alongside the existing convertibility check (parallel, both are read-only pre-flight I/O):

```ts
const nonClaimableSponsoredEntries = accountState.sponsoredEntries.filter(
  (e) => e.kind !== "claimable_balance"
);
const sponsorshipAffordability = accountState.sponsorshipEnumerationIncomplete
  ? { revocable: [], unaffordableOwners: new Map() }
  : await assessSponsorshipAffordability(source, nonClaimableSponsoredEntries, network);
```

Pass it as the 5th argument to `buildPlan`:

```ts
const buildResult = buildPlan(
  accountState,
  mediatorRequired,
  false,
  claimableBalanceSelections,
  sponsorshipAffordability
);
```

(Skipping the read entirely when enumeration is already known-incomplete avoids a wasted network round trip — `buildPlan` ignores the affordability result in that branch anyway per Task 5.)

- [ ] **Step 2: Write the failing test for the build-time live re-read**

In whichever test file covers `buildCloseTransactions` (located via the grep above), add a case: an account state with one `sponsoredEntries` item, mock `assessSponsorshipAffordability` (via `mock.module`) to return it as `revocable`, call `buildCloseTransactions`, and assert the resulting transaction's `covers` includes `"REVOKE_SPONSORSHIP"`. Add a second case where the mock returns it in `unaffordableOwners` instead and assert `covers` does NOT include `"REVOKE_SPONSORSHIP"` (the build silently omits it — Task 5 already turned this into a plan-time blocker, so reaching `/close/transactions` with an unresolved unaffordable entry would mean the client skipped the blocker, which is a client bug, not something this endpoint needs to re-explain; it simply builds without that entry).

- [ ] **Step 3: Implement in `build-transactions.ts`**

Import `assessSponsorshipAffordability`. In `buildCloseTransactions`, after the existing `assetActions` computation and before constructing `input: FusedCloseInput`, add:

```ts
const nonClaimableSponsoredEntries = accountState.sponsoredEntries.filter(
  (e) => e.kind !== "claimable_balance"
);
const sponsorshipAffordability = accountState.sponsorshipEnumerationIncomplete
  ? { revocable: [], unaffordableOwners: new Map() }
  : await assessSponsorshipAffordability(accountState.address, nonClaimableSponsoredEntries, network);
```

Add `revokeSponsorshipEntries: sponsorshipAffordability.revocable` to the main-round `input: FusedCloseInput` object, and `revokeSponsorshipEntries: []` to the claim-round `claimInput: FusedCloseInput` object (sponsorship revocation never belongs in the claim round — it has no ordering dependency on claiming and Task 5 already excludes any account with `sponsoredEntries` from ever reaching the fused/fast path where this distinction would matter less).

Update `buildSummary`:

```ts
function buildSummary(input: FusedCloseInput): string {
  const parts: string[] = [];
  if (input.revokeSponsorshipEntries.length > 0)
    parts.push(
      `revoke ${input.revokeSponsorshipEntries.length} sponsorship${input.revokeSponsorshipEntries.length === 1 ? "" : "s"}`
    );
  if (input.claimableBalances.length > 0)
    ...
```

(Insert this as the first `parts.push` so the summary reads naturally: "Revoke 1 sponsorship, remove 2 trustlines, merge the account into the destination.")

- [ ] **Step 4: Fix `step-engine.ts`'s `CLOSE_ACCOUNT` branch**

In `apps/api/src/lib/stellar/step-engine.ts`, the `FusedCloseInput` literal inside `case "CLOSE_ACCOUNT":` needs `revokeSponsorshipEntries: [],` added (this branch is only reachable for fast-path-eligible accounts, which Task 5 guarantees never have `sponsoredEntries`, so an empty array here is always correct, not just a type-checker appeasement).

- [ ] **Step 5: Run the tests**

Run: `bun run --filter '@lumenwipe/api' type-check && cd apps/api && bun test tests/unit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/close/close.controller.ts apps/api/src/lib/close-api/build-transactions.ts apps/api/src/lib/stellar/step-engine.ts apps/api/tests
git commit -m "feat(api): re-verify sponsorship affordability live immediately before building"
```

---

## Task 8: Result-code translation for `RevokeSponsorship` submission failures (defense in depth)

The affordability pre-check should make these rare, but per CLAUDE.md ("user-facing errors are plain language; never surface raw SDK codes"), any surviving submission failure still needs a translated message — mirrors every other operation family already in this file.

**Files:**
- Modify: `apps/api/src/lib/utils/errors.ts`
- Modify: `apps/web/lib/utils/errors.ts` (mirrors the API copy, matching this file's existing dual-maintenance pattern)

- [ ] **Step 1: Add the five result codes to both files**

Insert a new section (matching the existing `// ── X (STEP_TYPE) ──` comment-header convention) in both `RESULT_CODE_MESSAGES` maps:

```ts
// ── RevokeSponsorship (REVOKE_SPONSORSHIP) ──────────────────────────────────
revoke_sponsorship_does_not_exist: "The sponsored entry no longer exists - it may have already been removed.",
revoke_sponsorship_not_sponsor: "This account no longer sponsors that entry - someone else may have already resolved it.",
revoke_sponsorship_low_reserve: "The account that owns this entry does not have enough XLM to take over its reserve.",
revoke_sponsorship_only_transferable: "This entry requires a new sponsor to take over before its current sponsorship can be revoked.",
revoke_sponsorship_malformed: "The sponsorship revocation is malformed.",
```

- [ ] **Step 2: Verify no test asserts the exact old map contents**

Run: `grep -rn "RESULT_CODE_MESSAGES" apps/api/tests apps/web/tests`

If any test snapshots the full map, update it; otherwise this is additive and safe.

- [ ] **Step 3: Type-check both packages**

Run: `bun run --filter '@lumenwipe/api' type-check && bun run --filter '@lumenwipe/web' type-check`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/utils/errors.ts apps/web/lib/utils/errors.ts
git commit -m "feat: translate revoke-sponsorship submission failure codes"
```

---

## Task 9: API-side intent serialization (`apps/api/src/lib/stellar/intent/serialize.ts`)

Keeps the API's own `intent.operations` (returned to the client for display/debugging in `CloseTransaction.intent`) informative for the new op family. Not the trust boundary (Task 10 is), but should stay in parity.

**Files:**
- Modify: `apps/api/src/lib/stellar/intent/serialize.ts`
- Test: `apps/api/tests/unit/intent-serialize.test.ts` if it exists (`grep -rl intentFromXdr apps/api/tests`)

- [ ] **Step 1: Add the five cases to `normalizeOp`**

```ts
case "revokeAccountSponsorship":
  return { type: "revoke_sponsorship", entryKind: "account", owner: op.account };
case "revokeTrustlineSponsorship":
  return { type: "revoke_sponsorship", entryKind: "trustline", owner: op.account };
case "revokeOfferSponsorship":
  return { type: "revoke_sponsorship", entryKind: "offer", owner: op.seller };
case "revokeDataSponsorship":
  return { type: "revoke_sponsorship", entryKind: "data_entry", owner: op.account };
case "revokeSignerSponsorship":
  return { type: "revoke_sponsorship", entryKind: "signer", owner: op.account };
```

Insert these cases in the `switch (op.type)` block, anywhere before `default: return null;`. Note this file's `normalizeOp` returns `IntentOperation | null` and filters nulls (line 64) — these new cases must return a value, not fall through to `default`.

- [ ] **Step 2: Add a test case**

If `apps/api/tests/unit/intent-serialize.test.ts` exists, add a case building a real `revokeAccountSponsorship` XDR op (via `Operation.revokeAccountSponsorship({ account: <G-address> })` inside a minimal transaction), decoding it with `intentFromXdr`, and asserting the resulting operation is `{ type: "revoke_sponsorship", entryKind: "account", owner: <the address> }`. Otherwise, create the file following this codebase's existing intent-serialize test conventions (check the web-side equivalent test for the pattern, since `apps/web/tests/unit/intent-serialize.test.ts` exists per Task 10's investigation).

- [ ] **Step 3: Run and commit**

Run: `cd apps/api && bun test tests/unit/intent-serialize.test.ts` (or wherever added)

```bash
git add apps/api/src/lib/stellar/intent/serialize.ts apps/api/tests
git commit -m "feat(api): decode revoke-sponsorship operations in the transaction intent"
```

---

## Task 10: The trust anchor — `verify()`'s allowlist addition

This is the security-critical task the issue flags for a second reviewer. Read the Global Constraints section again before touching this file.

**Files:**
- Modify: `apps/web/lib/stellar/intent/serialize.ts`
- Modify: `apps/web/lib/stellar/verify.ts`
- Create: `apps/web/tests/unit/verify-revoke-sponsorship.test.ts`

**Interfaces:**
- Consumes: the `revoke_sponsorship` `IntentOperation` variant (Task 1, mirrored into `apps/web/types/close-api.ts` in Task 11 — do Task 11's type-mirroring step first, or inline it here; this plan does the mirror in Task 11 for organization, but the two are tightly coupled — implementer's choice on order, just don't compile this task without it).

- [ ] **Step 1: Write the failing tests first**

```ts
// apps/web/tests/unit/verify-revoke-sponsorship.test.ts
import { test, expect } from "bun:test";
import { Keypair, Operation, TransactionBuilder, Networks, Account } from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { assertCloseIntent, VerificationError } from "@/lib/stellar/verify";

const SOURCE_KP = Keypair.random();
const OWNER_KP = Keypair.random();
const DEST_KP = Keypair.random();

function baseExpected() {
  return {
    source: SOURCE_KP.publicKey(),
    destination: DEST_KP.publicKey(),
    mediator: null,
    memo: null,
    memoRequired: false,
    memoType: null as const,
    claimTrustlineAssets: [],
  };
}

test("verify › a plain revoke-account-sponsorship op is accepted", () => {
  const account = new Account(SOURCE_KP.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(() => assertCloseIntent(intent, baseExpected())).not.toThrow();
});

test("verify › a revoke op wrapped in a sponsorship-transfer bracket is rejected (the actual redirect attack)", () => {
  const attackerKp = Keypair.random();
  const account = new Account(SOURCE_KP.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: SOURCE_KP.publicKey(),
        source: attackerKp.publicKey(),
      })
    )
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: attackerKp.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(VerificationError);
});

test("verify › every revoke-sponsorship op kind is recognized and accepted", () => {
  const account = new Account(SOURCE_KP.publicKey(), "1");
  const issuer = Keypair.random().publicKey();
  const tx = new TransactionBuilder(account, { fee: "600", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(
      Operation.revokeTrustlineSponsorship({
        account: OWNER_KP.publicKey(),
        asset: new (require("@stellar/stellar-sdk").Asset)("USDC", issuer),
      })
    )
    .addOperation(Operation.revokeOfferSponsorship({ seller: OWNER_KP.publicKey(), offerId: "1" }))
    .addOperation(Operation.revokeDataSponsorship({ account: OWNER_KP.publicKey(), name: "foo" }))
    .addOperation(
      Operation.revokeSignerSponsorship({
        account: OWNER_KP.publicKey(),
        signer: { ed25519PublicKey: Keypair.random().publicKey() },
      })
    )
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(() => assertCloseIntent(intent, baseExpected())).not.toThrow();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd apps/web && bun test tests/unit/verify-revoke-sponsorship.test.ts`
Expected: the first and third tests FAIL (the ops decode to `{ type: "unknown" }` today, which `assertCloseIntent` already rejects — so right now ALL THREE tests "pass" in the sense that everything throws, but for the wrong reason on tests 1 and 3). To make this meaningful, temporarily assert in a scratch run that the failure message is the generic "unrecognized operation" one before implementing, confirming you're closing the right gap.

- [ ] **Step 3: Implement — `apps/web/lib/stellar/intent/serialize.ts`**

Add the same five cases as Task 9 to this file's `normalizeOp` (note this copy's `default:` branch returns `{ type: "unknown" }`, not `null` — insert the new cases before that `default`):

```ts
case "revokeAccountSponsorship":
  return { type: "revoke_sponsorship", entryKind: "account", owner: op.account };
case "revokeTrustlineSponsorship":
  return { type: "revoke_sponsorship", entryKind: "trustline", owner: op.account };
case "revokeOfferSponsorship":
  return { type: "revoke_sponsorship", entryKind: "offer", owner: op.seller };
case "revokeDataSponsorship":
  return { type: "revoke_sponsorship", entryKind: "data_entry", owner: op.account };
case "revokeSignerSponsorship":
  return { type: "revoke_sponsorship", entryKind: "signer", owner: op.account };
```

Do **not** add cases for `"beginSponsoringFutureReserves"` or `"endSponsoringFutureReserves"` — they must keep falling through to `default` and decoding as `{ type: "unknown" }`. This is the load-bearing invariant from Global Constraints.

- [ ] **Step 4: Implement — `apps/web/lib/stellar/verify.ts`**

Add a case to `assertCloseIntent`'s `switch (op.type)`, next to `account_merge`/`claim_claimable_balance`:

```ts
case "revoke_sponsorship":
  // CAP-33: RevokeSponsorship always reverts the entry's reserve burden to its own
  // owning account UNLESS the source account is sandwiched inside a
  // BeginSponsoringFutureReserves/EndSponsoringFutureReserves bracket, which would
  // instead transfer it to a new sponsor. normalizeOp never recognizes those two op
  // types (by design - see the module's case list), so any transaction containing one
  // already fails at the `case "unknown"` branch below before reaching here. That is
  // the entire safety guarantee for this op family: it structurally cannot redirect
  // reserve to a third party once sponsorship-transfer brackets are unreachable.
  break;
case "account_merge":
case "claim_claimable_balance":
  break;
```

- [ ] **Step 5: Run the new test file, then the full web test suite**

Run: `cd apps/web && bun test tests/unit/verify-revoke-sponsorship.test.ts`
Expected: all 3 pass.

Run: `bun test tests/unit/verify.test.ts tests/unit/intent-serialize.test.ts`
Expected: all pass (no regressions to the existing "unknown operation" rejection tests — confirm at least one existing test still asserts an unrelated unrecognized op, e.g. a raw `bumpSequence`, is still rejected).

- [ ] **Step 6: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: passes (this also compiles `apps/web/tests/tsconfig.json` per CLAUDE.md's note).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/stellar/intent/serialize.ts apps/web/lib/stellar/verify.ts apps/web/tests/unit/verify-revoke-sponsorship.test.ts
git commit -m "security(verify): recognize revoke-sponsorship operations in the trust anchor"
```

---

## Task 11: Mirror types into `apps/web/types/*` and render the step in the UI

**Files:**
- Modify: `apps/web/types/plan.ts`
- Modify: `apps/web/types/close-api.ts`
- Modify: `apps/web/lib/utils/stepIcons.tsx`
- Modify: `apps/web/components/plan/PlanAccordion.tsx`

**Interfaces:**
- Produces: web-local `StepType`/`IntentOperation` parity with `@lumenwipe/types` (required for Task 10 to compile) and a visible "Revoke sponsorships" group in the plan review UI.

- [ ] **Step 1: Mirror `StepType`**

In `apps/web/types/plan.ts`, add `"REVOKE_SPONSORSHIP"` to the `StepType` union in the same position as Task 1 (right after `"NORMALIZE_SIGNERS"`).

- [ ] **Step 2: Mirror the intent operation**

In `apps/web/types/close-api.ts`, add the same `revoke_sponsorship` variant from Task 1 to this file's `IntentOperation` union (placed before the `| { type: "unknown" }` member, which must stay last).

- [ ] **Step 3: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: Task 10's new `case "revoke_sponsorship"` cases now compile against a known member of the union (they'd have been a type error against the stale union before this step).

- [ ] **Step 4: Add an icon**

In `apps/web/lib/utils/stepIcons.tsx`, import `ShieldOff` from `lucide-react` and add to `ICON_MAP`:

```ts
REVOKE_SPONSORSHIP: ShieldOff,
```

- [ ] **Step 5: Render the group in `PlanAccordion.tsx`**

The plan review UI (issue #74, referenced by this issue) needs this group so it renders without a follow-up patch. `PlanAccordion` currently derives its groups from `AccountState` fields directly rather than from `PlannedStep[]` — follow that existing pattern.

Add `"REVOKE_SPONSORSHIP"` to the local `GroupType` union, then add a group push after the `NORMALIZE_SIGNERS` block:

```tsx
const revocableSponsorships = account.sponsoredEntries.filter((e) => e.kind !== "claimable_balance");
if (revocableSponsorships.length > 0) {
  groups.push({
    type: "REVOKE_SPONSORSHIP",
    title: "Revoke sponsorships",
    summary: `${revocableSponsorships.length} sponsored entr${revocableSponsorships.length === 1 ? "y" : "ies"} on other accounts`,
    body: (
      <ul className="space-y-1">
        {revocableSponsorships.map((entry, i) => (
          <li key={i} className="text-xs text-white/55">
            {entry.kind === "trustline" && `Trustline for ${entry.asset.split(":")[0]}`}
            {entry.kind === "offer" && `Offer ${entry.offerId}`}
            {entry.kind === "data_entry" && `Data entry "${entry.name}"`}
            {entry.kind === "signer" && "Signer"}
            {entry.kind === "account" && "Account creation"}
            {" "}
            <span className="font-mono-address text-white/35">on {shortAddr(entry.owner)}</span>
          </li>
        ))}
      </ul>
    ),
  });
}
```

This is a display-only best-effort preview (it does not distinguish affordable from unaffordable — that distinction is server-computed and arrives via `blockers`/decision points elsewhere in the flow, per issue #74's scope, not this one). Note `PlanAccordion` receives `account: AccountState` as a prop already — confirm `sponsoredEntries` reaches it through whatever data-fetching hook populates that prop; if the prop's source doesn't yet include the new fields (check `apps/web/lib/api/plan-adapters.ts` or equivalent), that's this task's Step 6.

- [ ] **Step 6: Confirm the account-state fetch path carries the new fields through**

Run: `grep -rn "AccountState" apps/web/lib/api apps/web/store --include="*.ts" -l`

Read each result; if any of them explicitly re-lists `AccountState` fields (rather than spreading a fetched JSON object into the type), add `sponsoredEntries`/`sponsorshipEnumerationIncomplete` there too. If they're pass-through JSON casts, no change needed — the API response already carries the fields since `packages/types` (the API's own source of truth) already has them.

- [ ] **Step 7: Manually verify in the browser**

Per CLAUDE.md's testing guidance for UI changes: start both services (`bun run dev:api` and `bun dev`), and on testnet, run through the guided close UI for an account that sponsors a trustline for another account (can be arranged via the same `beginSponsoringFutureReserves`/`changeTrust`/`endSponsoringFutureReserves` pattern used in the integration test in Task 12). Confirm the "Revoke sponsorships" group renders in the plan review accordion with the correct owner address and entry description.

- [ ] **Step 8: Run the full web unit test suite**

Run: `cd apps/web && bun test tests/unit`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/web/types/plan.ts apps/web/types/close-api.ts apps/web/lib/utils/stepIcons.tsx apps/web/components/plan/PlanAccordion.tsx
git commit -m "feat(web): render revoke-sponsorship steps in the plan review UI"
```

---

## Task 12: Testnet integration test (per §9.9)

**Files:**
- Create or extend: `apps/api/tests/integration/sponsorship.integration.test.ts` (the file already has the exact fixture-setup helpers this test needs — `fund`, the sponsor/sponsored/issuer keypair pattern, `readAccountStateUntilSponsoring`)

- [ ] **Step 1: Write the integration test**

Append to `apps/api/tests/integration/sponsorship.integration.test.ts`:

```ts
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";

test.skipIf(!RUN_INTEGRATION)(
  "assessSponsorshipAffordability + revokeSponsorshipOps › revoking a real sponsored trustline submits and updates reserve accounting",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const sponsor = Keypair.random();
    const sponsored = Keypair.random();
    const issuer = Keypair.random();
    await Promise.all([fund(sponsor.publicKey()), fund(sponsored.publicKey()), fund(issuer.publicKey())]);
    const asset = new Asset("LWTEST2", issuer.publicKey());

    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const setupTx = new TransactionBuilder(sponsorAccount, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: sponsored.publicKey(), source: sponsor.publicKey() }))
      .addOperation(Operation.changeTrust({ asset, source: sponsored.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }))
      .setTimeout(60)
      .build();
    setupTx.sign(sponsor);
    setupTx.sign(sponsored);
    await server.submitTransaction(setupTx);

    const state = await readAccountStateUntilSponsoring(sponsor.publicKey());
    expect(state.sponsoredEntries).toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: `LWTEST2:${issuer.publicKey()}`,
    });

    const affordability = await assessSponsorshipAffordability(sponsor.publicKey(), state.sponsoredEntries, "testnet");
    expect(affordability.revocable).toHaveLength(1);
    expect(affordability.unaffordableOwners.size).toBe(0);

    const freshSponsorAccount = await server.loadAccount(sponsor.publicKey());
    const revokeTx = new TransactionBuilder(freshSponsorAccount, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(revokeSponsorshipOps(affordability.revocable)[0])
      .setTimeout(60)
      .build();
    revokeTx.sign(sponsor);
    const result = await server.submitTransaction(revokeTx);
    expect(result.successful).toBe(true);

    // Fresh read: the sponsored account now self-sponsors, so this entry should no longer
    // show up as sponsored by `sponsor`.
    const after = await readAccountStateUntilSponsoring(sponsor.publicKey()).catch(() => null);
    // readAccountStateUntilSponsoring polls FOR numSponsoring >= 1, which is now false -
    // read directly instead of via that helper's success-biased retry.
    const direct = await getAccountState(sponsor.publicKey(), "testnet");
    expect(direct.sponsoredEntries).not.toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: `LWTEST2:${issuer.publicKey()}`,
    });
  },
  60000
);
```

Adjust the `after`/`direct` handling once you see real RPC ingestion-lag behavior on a live run — the existing file's comments already document this endpoint's lag characteristics; follow the same poll-with-cap pattern if a flat read proves flaky (`Operation.revokeSponsorshipOps` import path takes the array-returning function from Task 4, so `[0]` picks the single trustline-revoke op built for this one entry).

- [ ] **Step 2: Run it**

Run: `cd apps/api && LUMENWIPE_RUN_INTEGRATION=1 bun test tests/integration/sponsorship.integration.test.ts`
Expected: passes against real testnet (requires network access and may take up to 60s).

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/integration/sponsorship.integration.test.ts
git commit -m "test(api): verify revoke-sponsorship against a real testnet sponsorship"
```

---

## Task 13: Docs and final full-repo verification

**Files:**
- Modify: `docs/architecture.md` (§3's `ACCOUNT_MERGE_IS_SPONSOR` row currently says "Detect in pre-flight, block the merge, explain that sponsorships must be revoked first" — update to reflect the real fix)

- [ ] **Step 1: Update `docs/architecture.md` §3**

Find the pre-flight-checks table row for `ACCOUNT_MERGE_IS_SPONSOR` (around line 94) and update the "how handled" column from "Detect in pre-flight, block the merge, explain that sponsorships must be revoked first" to something like: "Detected in pre-flight; entries whose owner can absorb the shifted reserve are auto-resolved via `RevokeSponsorship` (per-owner affordability check), the rest surface as a specific per-entry blocker — see issue #72."

Also check line 101 ("Sponsorship detection prevents `ACCOUNT_MERGE_IS_SPONSOR`") and line 527 (glossary entry for "Sponsorship") for wording that implies detection-only; update if they'd mislead a reader into thinking this is still block-only.

- [ ] **Step 1b: Document the claimable-balance CAP-33 limitation as its own explicit note**

This is a deliberate, non-obvious design decision (a literal reading of issue #72's task list asked for a `revokeClaimableBalanceSponsorship` step; this plan does not build one — see Global Constraints) and must be discoverable by a future reader without re-deriving the CAP-33 analysis. Add a new paragraph immediately after line 103 (the existing "Note that being a _claimant_..." paragraph) in `docs/architecture.md` §3:

```markdown
**Claimable-balance sponsorships cannot be self-revoked.** CAP-33's `RevokeSponsorshipOp` fails
with `REVOKE_SPONSORSHIP_ONLY_TRANSFERABLE` when applied to a `CLAIMABLE_BALANCE` ledger entry
unless a cooperating new sponsor is sandwiched around it via `BeginSponsoringFutureReserves` /
`EndSponsoringFutureReserves` in the same transaction - every other sponsorable entry kind
(account, trustline, offer, data entry, signer) instead reverts to its own owning account's
default sponsorship, which is what this tool's `REVOKE_SPONSORSHIP` step relies on. A guided
close has no third party willing to become that new sponsor, so a claimable balance this account
sponsors is a permanent blocker until a claimant claims it (removing the entry, and its
sponsorship, entirely) - there is no self-service remediation. See issue #72's implementation
plan for the full CAP-33 citation.
```

Also check line 101 ("Sponsorship detection prevents `ACCOUNT_MERGE_IS_SPONSOR`") and line 527 (glossary entry for "Sponsorship") for wording that implies detection-only or implies all sponsorship kinds resolve the same way; update if they'd mislead a reader.

- [ ] **Step 2: Full verification matrix**

Run, in order, stopping to fix on any failure:

```bash
bun run --filter '@lumenwipe/types' type-check
bun run --filter '@lumenwipe/api' type-check
bun run --filter '@lumenwipe/web' type-check
bun run lint
cd apps/api && bun test tests/unit tests/e2e && cd ../..
cd apps/web && bun test tests/unit && cd ../..
bun run format --check 2>/dev/null || bun run format
```

(Adjust the exact `lint`/`format` invocations to match `package.json`'s actual script names if they differ from CLAUDE.md's documented `bun run lint | type-check | test`.)

- [ ] **Step 3: Re-read the diff end to end**

Run: `git diff main --stat` then review the full diff once, specifically re-checking: (a) `apps/web/lib/stellar/verify.ts` and `apps/web/lib/stellar/intent/serialize.ts` never gained `beginSponsoringFutureReserves`/`endSponsoringFutureReserves` recognition; (b) `revokeSponsorshipOps` is never called with a `claimable_balance` entry anywhere in the diff; (c) every new/modified `FusedCloseInput` object literal sets `revokeSponsorshipEntries` deliberately, not just to silence the compiler.

- [ ] **Step 4: Commit the docs update**

```bash
git add docs/architecture.md
git commit -m "docs: describe the resolved sponsorship-revocation flow"
```

---

## Self-Review Notes (for the plan author / first reader, not a task)

- **Spec coverage:** every checkbox in issue #72's task list maps to a task above, except the literal ask to wire `revokeClaimableBalanceSponsorship` into the auto-generated step — deliberately not done, per the CAP-33 finding in Global Constraints. This is the one place this plan overrides the issue's literal text; flag it prominently in the PR description and to the second reviewer.
- **Acceptance criteria mapping:** the four `buildPlan.test.ts` cases in Task 5 are verbatim the issue's "Acceptance" bullet ("affordable → step, no blocker; unaffordable → blocker, no step; mixed → partial resolution"). The `verify()` allowlist test in Task 10 is the issue's "tampered revoke op that redirects reserve to an unexpected account is rejected" bullet, realized as the sponsorship-transfer-bracket attack (the only real mechanism CAP-33 offers for a redirect). The testnet integration test in Task 12 matches the issue's integration-test bullet exactly (two funded accounts, `BeginSponsoringFutureReserves`/`ChangeTrust`/`EndSponsoringFutureReserves`, then a live `RevokeSponsorship` submit and a fresh-read assertion).
- **Type consistency check:** `SponsoredEntry["kind"]` (from `@lumenwipe/types`) is used as the literal source for `entryKind` in `IntentOperation`'s `revoke_sponsorship` variant (Task 1) rather than re-declaring the five-member union by hand in two places — actually, Task 1 inlines the literal union rather than importing `SponsoredEntry` into `close-api.ts`, to avoid a new cross-file coupling in `packages/types` (that file currently only imports from `./network`). Confirm during implementation that the inlined literal (`"account" | "trustline" | "offer" | "data_entry" | "signer"`) is kept byte-for-byte in sync with `SponsoredEntry`'s non-claimable-balance kinds if `SponsoredEntry` ever changes — a lint rule or comment cross-reference is worth adding if this drifts in practice.
