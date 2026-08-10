# Sponsorship Entry Enumeration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `AccountState` a `sponsoredEntries: SponsoredEntry[]` list (which ledger entries this account currently sponsors, and on whose accounts) alongside the existing `numSponsoring` count, with an honest `sponsorshipEnumerationIncomplete` flag whenever the enumeration cannot be trusted as complete. Closes GitHub issue #71.

**Architecture:** Two-phase read, not event replay. Phase 1 (discovery) pages through `GET /accounts/{sponsor}/operations` — confirmed empirically to be participant-inclusive, unlike `/effects` — to find candidate `(owner, kind, key)` tuples this account has ever been involved in sponsoring. Phase 2 (verification) does one live read per discovered owner account and checks each entry's _current_ `sponsor` field (Horizon exposes this directly on trustlines, signers, offers, per-key data, and the account resource itself). Only entries whose live sponsor still equals our address survive. This means Phase 1 only has to be reasonably complete, never perfectly correct — any parsing gap in Phase 1 can only produce a missed _candidate_ (caught by the `numSponsoring` cross-check below), never a wrong _inclusion_, because Phase 2 always re-derives truth from current chain state. Claimable balances skip both phases and use Horizon's direct `?sponsor=` list filter, mirroring the existing `?claimant=` fetcher.

**Tech Stack:** TypeScript, `@stellar/stellar-sdk` (server-side only), Horizon-compatible REST adapter (`PATH_ROUTING_API_URLS`), Bun test runner, NestJS (apps/api).

## Global Constraints

- Single source of truth for types: `packages/types/src/account.ts`. Never add a local copy under `apps/web`.
- An incomplete enumeration must surface as `sponsorshipEnumerationIncomplete: true`, never as a silent empty list. This is the issue's core security requirement.
- This issue is enumeration only. Do not touch `tx-builder/index.ts`'s existing `numSponsoring > 0` blocker — that stays until #72.
- `bun type-check && bun lint && bun test` must pass for `@lumenwipe/api` (and the repo-wide matrix, since `packages/types` is shared).
- No mainnet calls from automated tests. The new testnet-dependent test must not run inside the default `bun test` / CI path (mirrors how `apps/web`'s Playwright testnet suite is `test:e2e`, excluded from CI's `test` step).
- Comments only where the _why_ is non-obvious (existing repo convention).

---

## Investigation findings (verified live against Stellar testnet — post as a comment on issue #71 before writing code, per the issue's own instruction)

The issue names two candidate data sources and asks which is "actually complete enough to use" before committing. Both were tested against a real testnet account that sponsors a trustline (`BeginSponsoringFutureReserves` → `ChangeTrust` → `EndSponsoringFutureReserves`), submitted and confirmed on testnet, hash `7c609a8d...`:

1. **stellar.expert's `/account/{address}` endpoint exposes nothing about sponsorship.** A sponsor account with `num_sponsoring: 1` on Horizon returns only `{account, created, creator, payments, trades, activity, assets}` from stellar.expert — no sponsoring count, no sponsored-entry list. Ruled out entirely; `apps/api/src/lib/se-api/client.ts` (`seGet`) is not usable for this.

2. **The literal reading of "replay effects from `GET /accounts/{id}/effects`" is broken for the sponsor's own account, and would silently produce exactly the false-negative the issue warns against.** Horizon attributes sponsorship-effect types (`trustline_sponsorship_created`, `_updated`, `_removed`, and the equivalent for data/signers/accounts/claimable balances) **only to the entry's owning account's effects stream, never to the sponsor's.** Verified directly: after the sponsor above sponsored a trustline, `GET /accounts/{sponsor}/effects` returned only `account_created` and `signer_created` — zero sponsorship effects — while `GET /accounts/{trustee}/effects` showed `trustline_created` and `trustline_sponsorship_created` (with the correct `sponsor` field) for the exact same operation. A sponsorship-transfer test (sponsor A → sponsor B, real testnet tx) confirmed the same asymmetry: A's effects show nothing, the _trustee's_ effects show `trustline_sponsorship_updated` with `former_sponsor`/`new_sponsor`. Naively porting the issue's suggested approach onto the sponsor's own effects stream would always return `[]` and get silently read as "sponsors nothing" — the exact bug the issue's "Security-sensitive" section is warning about.

3. **What does work, verified empirically:** `GET /accounts/{sponsor}/operations` is _participant-inclusive_ — it returns every operation in a transaction that touches the sponsor, including `begin_sponsoring_future_reserves`/`end_sponsoring_future_reserves`/`revoke_sponsorship` operations _sourced by the sponsoree_, as long as the sponsor is a party via an open sponsorship bracket in that transaction. Confirmed on all three probe transactions. Separately, Horizon's live per-entry resources already expose a `sponsor` field directly: trustline balances (`/accounts/{id}` → `balances[].sponsor`), signers (`/accounts/{id}` → `signers[].sponsor`), offers (`/accounts/{id}/offers` → records `.sponsor`), per-key data (`/accounts/{id}/data/{key}` → `.sponsor`), and the account resource itself (`/accounts/{id}` → `.sponsor`, already read today in `account-live.ts`). Operation resources for `change_trust`, `manage_data`, and `set_options` also carry a `sponsor` field directly at creation time (confirmed via JSON dump) — offers do not carry a resolvable ID on creation (`manage_sell_offer`'s `offer_id` field stays `"0"` for a fresh offer; the real ID only appears on the live `/accounts/{id}/offers` resource), so offer discovery relies on owner-level candidates rather than a specific offer ID from history.
   `RevokeSponsorship`'s per-kind field names (confirmed against Horizon's API reference): `account_id`; `trustline_account_id` + `trustline_asset`; `offer_id`; `data_account_id` + `data_name`; `claimable_balance_id`; `signer_account_id` + `signer_key`.

4. **Claimable balances have a direct, complete source**: Horizon's `GET /claimable_balances?sponsor=<address>` list filter (the existing `fetchClaimableBalancesForClaimant` in `horizon-adapter.ts` already uses the sibling `?claimant=` filter against the same endpoint) — no discovery/replay needed for this one kind.

**Conclusion:** discovery via `/accounts/{sponsor}/operations` (never `/effects`) to find candidate owner accounts, live re-verification of each candidate against Horizon's current per-entry `sponsor` fields, and a direct `?sponsor=` query for claimable balances. This also means Phase 1 doesn't need to model the tricky bracket/transfer state machine at all — Phase 2's live read makes that unnecessary, since it always reflects current truth regardless of how many times an entry changed sponsors historically.

---

## File Structure

- `packages/types/src/account.ts` — add `SponsoredEntry` discriminated union; add `sponsoredEntries`/`sponsorshipEnumerationIncomplete` to `AccountState`.
- `apps/api/src/lib/stellar/sponsorship-reconcile.ts` **(new)** — pure decision logic: given discovered candidates + live per-owner state + the CB list + completeness signals, produce the final `sponsoredEntries` and `sponsorshipEnumerationIncomplete`. No I/O. This is what the acceptance criteria's three unit-test scenarios target.
- `apps/api/src/lib/stellar/sponsorship.ts` **(new)** — I/O: Phase 1 discovery (paginate `/accounts/{address}/operations`), Phase 2 live verification (per-owner fetches), CB-by-sponsor fetch, orchestrates via `reconcileSponsoredEntries`. Exports `enumerateSponsoredEntries(address, network, numSponsoring)`.
- `apps/api/src/lib/stellar/account.ts` — call `enumerateSponsoredEntries` inside `getAccountState`, populate the two new fields.
- `apps/api/src/lib/stellar/account-live.ts` — same call inside `getLiveAccountState` (the Horizon-live fallback path `read-account.ts` swaps to on `needsLiveRescan`; both paths must populate these fields or the fallback silently drops them).
- `apps/api/src/config/constants.ts` — add `SPONSORSHIP_MAX_OPERATIONS_SCANNED`.
- Six existing `apps/api/tests/unit/*.test.ts` fixture files — add the two new required `AccountState` fields to each `makeAccount()`/equivalent factory default.
- `apps/api/tests/unit/sponsorship-reconcile.test.ts` **(new)** — the three required scenarios (net-zero, re-sponsored by a different account, paginated cutoff) plus the happy path and the count cross-check.
- `apps/api/tests/integration/sponsorship.integration.test.ts` **(new)** — real testnet test per the acceptance criteria.
- `apps/api/package.json` — split `test` script to exclude the new `tests/integration/` tier from the default/CI run; add `test:integration`.
- `CONTRIBUTING.md` §8 — document the new integration tier (one paragraph, matches the doc drift the investigation surfaced against `docs/architecture.md` §17's aspirational 4-tier model).

**Explicitly out of scope** (flag in the PR description, do not fix here): `apps/web/types/account.ts` is a byte-for-byte duplicate of `packages/types/src/account.ts` that ten `apps/web` files import from directly instead of `@lumenwipe/types`. Since no `apps/web` UI surfaces sponsorship data yet (no blocker/step changes in this issue), the new fields are not added to that duplicate — doing so would extend, not fix, the duplication. Pre-existing gap, worth a follow-up issue, not this one.

---

### Task 1: Post investigation findings to issue #71, then add `SponsoredEntry` and extend `AccountState`

**Files:**

- Modify: `packages/types/src/account.ts`
- Modify (fixture-only additions): `apps/api/tests/unit/close-api-decisions.test.ts`, `apps/api/tests/unit/fastPath.test.ts`, `apps/api/tests/unit/scan-fallback.test.ts`, `apps/api/tests/unit/closeAccountDisposition.test.ts`, `apps/api/tests/unit/buildPlan.test.ts`, `apps/api/tests/unit/buildCloseTransactionsClaimable.test.ts`

**Interfaces:**

- Produces: `SponsoredEntry` (discriminated union on `kind`), `AccountState.sponsoredEntries: SponsoredEntry[]`, `AccountState.sponsorshipEnumerationIncomplete: boolean` — every later task consumes these exact names.

- [ ] **Step 1: Post the investigation comment on issue #71**

Post this comment via `gh issue comment 71 --repo LumenWipe/lumenwipe --body-file <file>` (confirm with the user first — this posts to a shared, externally-visible GitHub issue):

```markdown
## Investigation: data source for sponsorship enumeration

Verified live against Stellar testnet (BeginSponsoringFutureReserves → ChangeTrust →
EndSponsoringFutureReserves, real submitted transactions).

**stellar.expert's `/account/{address}` is not usable** — it returns
`{account, created, creator, payments, trades, activity, assets}`, nothing about
sponsorship, even for an account with `num_sponsoring > 0` on Horizon.

**A literal reading of "replay effects from `GET /accounts/{id}/effects`" is broken for
the sponsor's own account.** Horizon attributes sponsorship effect types
(`trustline_sponsorship_created`/`_updated`/`_removed`, and the data/signer/account/CB
equivalents) only to the entry's _owning_ account's effects stream, never to the
sponsor's. Confirmed: the sponsor's own `/effects` showed zero sponsorship-related
effects for an entry it was actively sponsoring; the trustee's `/effects` showed
`trustline_sponsorship_created` with the correct `sponsor` field for the same
operation. Building this against the sponsor's own effects stream, as literally
described, would always return `[]` and silently read as "sponsors nothing" — exactly
the false-negative this issue's security note warns about.

**What does work:** `GET /accounts/{sponsor}/operations` is participant-inclusive —
it surfaces `begin_sponsoring_future_reserves`/`revoke_sponsorship`/wrapped operations
even when sourced by the sponsoree, as long as the sponsor has an open sponsorship
bracket in that transaction. Combined with Horizon's live per-entry `sponsor` fields
(present on trustlines, signers, offers, per-key data, and the account resource
itself), this gives a two-phase approach: discover candidate owner accounts from
operation history, then re-verify each entry's _current_ sponsor live. Claimable
balances skip both phases — `GET /claimable_balances?sponsor=<address>` is a direct,
complete filter, mirroring the existing `?claimant=` fetcher in
`apps/api/src/lib/stellar/horizon-adapter.ts`.

Implementation in progress on a branch off this issue.
```

- [ ] **Step 2: Add `SponsoredEntry` and extend `AccountState`**

In `packages/types/src/account.ts`, add after `PoolShareEntry` and before `AccountState`:

```typescript
/**
 * A ledger entry this account currently sponsors, on another account (or itself, for
 * "account" - a fully-sponsored account creation). Mirrors the ledger-key kinds
 * RevokeSponsorship supports. Claimable balances have no owning-account concept in
 * their ledger key (unlike the other five kinds), so they carry only balanceId.
 */
export type SponsoredEntry =
  | { kind: "account"; owner: string }
  | { kind: "trustline"; owner: string; asset: string }
  | { kind: "offer"; owner: string; offerId: string }
  | { kind: "data_entry"; owner: string; name: string }
  | { kind: "signer"; owner: string; signerKey: string }
  | { kind: "claimable_balance"; balanceId: string };
```

In the `AccountState` interface, immediately after the existing `numSponsoring: number;` field (keep sponsorship-related fields grouped, matching the existing comment style used for `subEntryMismatch`):

```typescript
  numSponsoring: number;
  /** Ledger entries this account currently sponsors (on other accounts, or itself via a
   *  fully-sponsored account creation). Populated by replaying sponsorship-relevant
   *  operations and re-verifying each candidate's live sponsor - see sponsorship.ts. */
  sponsoredEntries: SponsoredEntry[];
  /** True when sponsoredEntries could not be enumerated completely (pagination cut off,
   *  a live re-verification fetch failed, or the enumerated count doesn't match
   *  numSponsoring). Mirrors subEntryMismatch: an incomplete read must never be treated
   *  as "sponsors nothing" downstream. */
  sponsorshipEnumerationIncomplete: boolean;
```

- [ ] **Step 3: Update the six existing `AccountState` test fixtures**

In each of the six files below, the fixture factory has a line `subEntryMismatch: false,` (confirmed at these exact line numbers). Add the two new fields immediately after it:

```typescript
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
```

Files and lines: `apps/api/tests/unit/close-api-decisions.test.ts:31`, `apps/api/tests/unit/fastPath.test.ts:25`, `apps/api/tests/unit/scan-fallback.test.ts:26` (leave the second occurrence at line 119, `subEntryMismatch: true,` inside a `makeAccount({...})` override call, untouched — overrides only need to change fields they're testing), `apps/api/tests/unit/closeAccountDisposition.test.ts:50`, `apps/api/tests/unit/buildPlan.test.ts:29`, `apps/api/tests/unit/buildCloseTransactionsClaimable.test.ts:34`.

- [ ] **Step 4: Verify the package compiles**

Run: `cd apps/api && bun run type-check`
Expected: no errors about missing `sponsoredEntries`/`sponsorshipEnumerationIncomplete` on any `AccountState` literal.

Run: `cd packages/types && bun run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/account.ts apps/api/tests/unit/close-api-decisions.test.ts apps/api/tests/unit/fastPath.test.ts apps/api/tests/unit/scan-fallback.test.ts apps/api/tests/unit/closeAccountDisposition.test.ts apps/api/tests/unit/buildPlan.test.ts apps/api/tests/unit/buildCloseTransactionsClaimable.test.ts
git commit -m "feat(types): add SponsoredEntry and sponsoredEntries to AccountState"
```

---

### Task 2: Pure reconciliation logic (`sponsorship-reconcile.ts`) + unit tests

**Files:**

- Create: `apps/api/src/lib/stellar/sponsorship-reconcile.ts`
- Test: `apps/api/tests/unit/sponsorship-reconcile.test.ts`

**Interfaces:**

- Consumes: `SponsoredEntry` from `@lumenwipe/types` (Task 1).
- Produces: `SponsorshipCandidate`, `OwnerLiveState`, `reconcileSponsoredEntries(...)` — consumed by Task 3's I/O layer.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/unit/sponsorship-reconcile.test.ts`:

```typescript
import { test, expect } from "bun:test";
import {
  reconcileSponsoredEntries,
  type SponsorshipCandidate,
  type OwnerLiveState,
} from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

const SPONSOR = "GSPONSOR000000000000000000000000000000000000000000000";
const OTHER_SPONSOR = "GOTHER0000000000000000000000000000000000000000000000";
const OWNER = "GOWNER00000000000000000000000000000000000000000000000";

function liveState(overrides: Partial<OwnerLiveState> = {}): OwnerLiveState {
  return {
    accountSponsor: null,
    trustlineSponsors: {},
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: false,
    ...overrides,
  };
}

test("reconcileSponsoredEntries › entry sponsored then later un-sponsored (net zero) → excluded", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        trustlineSponsors: { "USD:GISSUER0000000000000000000000000000000000000000000": null },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    0
  );

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › entry re-sponsored by a different account → excluded", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        trustlineSponsors: {
          "USD:GISSUER0000000000000000000000000000000000000000000": OTHER_SPONSOR,
        },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    0
  );

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › still-current sponsorship → included with the right shape", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
    { kind: "signer", owner: OWNER, key: "GSIGNER00000000000000000000000000000000000000000000000" },
    { kind: "account", owner: OWNER, key: "" },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        accountSponsor: SPONSOR,
        trustlineSponsors: { "USD:GISSUER0000000000000000000000000000000000000000000": SPONSOR },
        signerSponsors: { GSIGNER00000000000000000000000000000000000000000000000: SPONSOR },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    3
  );

  expect(result.sponsoredEntries).toContainEqual({ kind: "account", owner: OWNER });
  expect(result.sponsoredEntries).toContainEqual({
    kind: "trustline",
    owner: OWNER,
    asset: "USD:GISSUER0000000000000000000000000000000000000000000",
  });
  expect(result.sponsoredEntries).toContainEqual({
    kind: "signer",
    owner: OWNER,
    signerKey: "GSIGNER00000000000000000000000000000000000000000000000",
  });
  expect(result.sponsoredEntries).toHaveLength(3);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › offer candidates sweep the owner's full current offer list", () => {
  const candidates: SponsorshipCandidate[] = [{ kind: "offer", owner: OWNER, key: "" }];
  const liveStateByOwner = new Map([
    [OWNER, liveState({ offerSponsors: { "12345": SPONSOR, "67890": OTHER_SPONSOR } })],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    1
  );

  expect(result.sponsoredEntries).toEqual([{ kind: "offer", owner: OWNER, offerId: "12345" }]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › claimable balances pass through directly", () => {
  const cbEntries: SponsoredEntry[] = [{ kind: "claimable_balance", balanceId: "00000000abc" }];

  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), cbEntries, false, false, 1);

  expect(result.sponsoredEntries).toEqual(cbEntries);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › paginated operations history cut off mid-scan → incomplete", () => {
  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), [], true, false, 0);

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › claimable balance list truncated → incomplete", () => {
  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), [], false, true, 0);

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › a live re-verification fetch failed → incomplete even though nothing else did", () => {
  const candidates: SponsorshipCandidate[] = [{ kind: "trustline", owner: OWNER, key: "native" }];
  const liveStateByOwner = new Map([[OWNER, liveState({ fetchFailed: true })]]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    1
  );

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › enumerated count disagrees with ledger-truth numSponsoring → incomplete", () => {
  // Everything reported complete, but we only found 1 entry while the ledger says 2 -
  // mirrors detectSubEntryMismatch's philosophy: an undercount is never trusted silently.
  const candidates: SponsorshipCandidate[] = [{ kind: "trustline", owner: OWNER, key: "native" }];
  const liveStateByOwner = new Map([
    [OWNER, liveState({ trustlineSponsors: { native: SPONSOR } })],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    2
  );

  expect(result.sponsoredEntries).toHaveLength(1);
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun test tests/unit/sponsorship-reconcile.test.ts`
Expected: FAIL — `Cannot find module '@/lib/stellar/sponsorship-reconcile'`.

- [ ] **Step 3: Implement `sponsorship-reconcile.ts`**

Create `apps/api/src/lib/stellar/sponsorship-reconcile.ts`:

```typescript
import type { SponsoredEntry } from "@lumenwipe/types";

export interface SponsorshipCandidate {
  kind: SponsoredEntry["kind"];
  owner: string;
  // Asset string for "trustline", data name for "data_entry", signer key for
  // "signer". Unused for "offer" (owner's full current offer list is swept
  // instead - see the module doc comment) and "account" (owner is the key).
  key: string;
}

export interface OwnerLiveState {
  // Top-level account "sponsor" field - relevant to "account"-kind candidates.
  accountSponsor: string | null;
  // Keyed by asset string ("native" or "CODE:ISSUER").
  trustlineSponsors: Record<string, string | null>;
  // Keyed by signer public key.
  signerSponsors: Record<string, string | null>;
  // Keyed by offer ID. Populated from the owner's full current offer list,
  // not from historical candidate keys (manage_offer operations don't expose
  // the assigned ID for a fresh offer - see sponsorship.ts).
  offerSponsors: Record<string, string | null>;
  // Keyed by data entry name.
  dataSponsors: Record<string, string | null>;
  // True if any live fetch for this owner failed - the candidate can't be
  // confirmed or ruled out, so it must never be silently dropped.
  fetchFailed: boolean;
}

// Phase 2 always re-derives truth from current chain state, so a Phase 1 gap can only
// produce a missed candidate (caught by the numSponsoring cross-check below), never a
// wrong inclusion. This is why this function does not need to model the sponsorship
// bracket/transfer state machine at all.
export function reconcileSponsoredEntries(
  address: string,
  candidates: SponsorshipCandidate[],
  liveStateByOwner: Map<string, OwnerLiveState>,
  claimableBalanceEntries: SponsoredEntry[],
  discoveryIncomplete: boolean,
  claimableBalanceIncomplete: boolean,
  numSponsoring: number
): { sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean } {
  const seen = new Set<string>();
  const sponsoredEntries: SponsoredEntry[] = [...claimableBalanceEntries];
  for (const e of claimableBalanceEntries) {
    if (e.kind === "claimable_balance") seen.add(`claimable_balance:${e.balanceId}`);
  }

  let anyLiveFetchFailed = false;

  for (const candidate of candidates) {
    const live = liveStateByOwner.get(candidate.owner);
    if (!live) continue; // no live data fetched for this owner - nothing to confirm
    if (live.fetchFailed) {
      anyLiveFetchFailed = true;
      continue;
    }

    if (candidate.kind === "offer") {
      for (const [offerId, sponsor] of Object.entries(live.offerSponsors)) {
        if (sponsor !== address) continue;
        const dedupeKey = `offer:${candidate.owner}:${offerId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        sponsoredEntries.push({ kind: "offer", owner: candidate.owner, offerId });
      }
      continue;
    }

    if (candidate.kind === "claimable_balance") continue; // handled above

    const currentSponsor =
      candidate.kind === "account"
        ? live.accountSponsor
        : candidate.kind === "trustline"
          ? (live.trustlineSponsors[candidate.key] ?? null)
          : candidate.kind === "signer"
            ? (live.signerSponsors[candidate.key] ?? null)
            : (live.dataSponsors[candidate.key] ?? null);

    if (currentSponsor !== address) continue;

    const dedupeKey = `${candidate.kind}:${candidate.owner}:${candidate.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (candidate.kind === "account") {
      sponsoredEntries.push({ kind: "account", owner: candidate.owner });
    } else if (candidate.kind === "trustline") {
      sponsoredEntries.push({ kind: "trustline", owner: candidate.owner, asset: candidate.key });
    } else if (candidate.kind === "signer") {
      sponsoredEntries.push({ kind: "signer", owner: candidate.owner, signerKey: candidate.key });
    } else {
      sponsoredEntries.push({ kind: "data_entry", owner: candidate.owner, name: candidate.key });
    }
  }

  const countMismatch = sponsoredEntries.length !== numSponsoring;

  return {
    sponsoredEntries,
    sponsorshipEnumerationIncomplete:
      discoveryIncomplete || claimableBalanceIncomplete || anyLiveFetchFailed || countMismatch,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun test tests/unit/sponsorship-reconcile.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/stellar/sponsorship-reconcile.ts apps/api/tests/unit/sponsorship-reconcile.test.ts
git commit -m "feat(api): add pure sponsorship enumeration reconciliation logic"
```

---

### Task 3: I/O layer (`sponsorship.ts`) — discovery, live verification, orchestration

**Files:**

- Create: `apps/api/src/lib/stellar/sponsorship.ts`
- Modify: `apps/api/src/config/constants.ts`

**Interfaces:**

- Consumes: `SponsorshipCandidate`, `OwnerLiveState`, `reconcileSponsoredEntries` (Task 2); `PATH_ROUTING_API_URLS`, `Network` (`@/config/networks`); `horizonAssetToString` (`@/lib/utils/assets`); `parseClaimPredicate` (`@/lib/stellar/horizon-adapter`, reused for the CB fetch).
- Produces: `enumerateSponsoredEntries(address: string, network: Network, numSponsoring: number): Promise<{ sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean }>` — consumed by Task 4.

- [ ] **Step 1: Add the scan-depth constant**

In `apps/api/src/config/constants.ts`, after `SE_API_MAX_RETRIES`:

```typescript
// Sponsorship enumeration: how many of the sponsor's own operations we'll page through
// (oldest-first, from account creation) looking for sponsorship-bracket candidates
// before giving up and flagging the read as incomplete. 2000 = 10 pages at 200/page.
export const SPONSORSHIP_MAX_OPERATIONS_SCANNED = 2000;
```

- [ ] **Step 2: Implement `sponsorship.ts`**

Create `apps/api/src/lib/stellar/sponsorship.ts`:

```typescript
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import { SPONSORSHIP_MAX_OPERATIONS_SCANNED } from "@/config/constants";
import { horizonAssetToString } from "@/lib/utils/assets";
import { parseClaimPredicate } from "@/lib/stellar/horizon-adapter";
import {
  reconcileSponsoredEntries,
  type SponsorshipCandidate,
  type OwnerLiveState,
} from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

const OPERATIONS_PAGE_LIMIT = 200;
const CB_PAGE_LIMIT = 200;
const CB_MAX_TOTAL = 1000;

interface HorizonOperation {
  type: string;
  source_account: string;
  sponsor?: string;
  sponsored_id?: string; // begin_sponsoring_future_reserves
  asset_type?: string; // change_trust
  asset_code?: string;
  asset_issuer?: string;
  name?: string; // manage_data
  signer_key?: string; // set_options / revoke_sponsorship
  account_id?: string; // revoke_sponsorship
  trustline_account_id?: string; // revoke_sponsorship
  trustline_asset?: string; // revoke_sponsorship, already "CODE:ISSUER"
  data_account_id?: string; // revoke_sponsorship
  data_name?: string; // revoke_sponsorship
  signer_account_id?: string; // revoke_sponsorship
}

interface HorizonOperationsPage {
  _embedded?: { records?: HorizonOperation[] };
  _links?: { next?: { href?: string } };
}

// Phase 1: discover candidate (owner, kind, key) tuples this account has ever been
// involved in sponsoring, by paging its own participant-inclusive operations list
// (verified against testnet: unlike /effects, /operations DOES surface operations
// sourced by the sponsoree while this account has an open sponsorship bracket).
// Never perfectly precise - see the module doc comment on reconcileSponsoredEntries
// for why that's fine.
async function discoverSponsorshipCandidates(
  address: string,
  network: Network
): Promise<{ candidates: SponsorshipCandidate[]; incomplete: boolean }> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { candidates: [], incomplete: true };

  const candidates: SponsorshipCandidate[] = [];
  let scanned = 0;
  let incomplete = false;
  let nextUrl: string | null =
    `${base}/accounts/${address}/operations?order=asc&limit=${OPERATIONS_PAGE_LIMIT}`;

  while (nextUrl) {
    if (scanned >= SPONSORSHIP_MAX_OPERATIONS_SCANNED) {
      incomplete = true;
      break;
    }

    let res: Response;
    try {
      res = await fetch(nextUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      incomplete = true;
      break;
    }
    if (!res.ok) {
      incomplete = true;
      break;
    }

    const page = (await res.json()) as HorizonOperationsPage;
    const records = page._embedded?.records ?? [];
    scanned += records.length;

    for (const op of records) {
      if (op.type === "begin_sponsoring_future_reserves" && op.source_account === address) {
        if (op.sponsored_id) candidates.push({ kind: "account", owner: op.sponsored_id, key: "" });
        continue;
      }
      if (op.type === "change_trust" && op.sponsor === address) {
        candidates.push({
          kind: "trustline",
          owner: op.source_account,
          key: horizonAssetToString({
            asset_type: op.asset_type ?? "native",
            asset_code: op.asset_code,
            asset_issuer: op.asset_issuer,
          }),
        });
        continue;
      }
      if (op.type === "manage_data" && op.sponsor === address && op.name) {
        candidates.push({ kind: "data_entry", owner: op.source_account, key: op.name });
        continue;
      }
      if (
        (op.type === "manage_buy_offer" || op.type === "manage_sell_offer") &&
        op.sponsor === address
      ) {
        candidates.push({ kind: "offer", owner: op.source_account, key: "" });
        continue;
      }
      if (op.type === "set_options" && op.sponsor === address && op.signer_key) {
        candidates.push({ kind: "signer", owner: op.source_account, key: op.signer_key });
        continue;
      }
      if (op.type === "revoke_sponsorship") {
        if (op.account_id) candidates.push({ kind: "account", owner: op.account_id, key: "" });
        if (op.trustline_account_id && op.trustline_asset) {
          candidates.push({
            kind: "trustline",
            owner: op.trustline_account_id,
            key: op.trustline_asset,
          });
        }
        if (op.data_account_id && op.data_name) {
          candidates.push({ kind: "data_entry", owner: op.data_account_id, key: op.data_name });
        }
        if (op.signer_account_id && op.signer_key) {
          candidates.push({ kind: "signer", owner: op.signer_account_id, key: op.signer_key });
        }
      }
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === OPERATIONS_PAGE_LIMIT ? nextHref : null;
  }

  return { candidates, incomplete };
}

interface HorizonAccountForSponsorship {
  sponsor?: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    sponsor?: string;
  }>;
  signers: Array<{ key: string; sponsor?: string }>;
}

interface HorizonOffer {
  id: string | number;
  sponsor?: string;
}

interface HorizonOffersPage {
  _embedded?: { records?: HorizonOffer[] };
  _links?: { next?: { href?: string } };
}

// Phase 2: for one owner account discovered in Phase 1, read its CURRENT sponsor
// fields directly from Horizon - this is the actual source of truth, not the history.
async function fetchOwnerLiveState(
  owner: string,
  network: Network,
  needsOffers: boolean,
  dataKeys: string[]
): Promise<OwnerLiveState> {
  const base = PATH_ROUTING_API_URLS[network];
  const empty: OwnerLiveState = {
    accountSponsor: null,
    trustlineSponsors: {},
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: true,
  };
  if (!base) return empty;

  try {
    const accountRes = await fetch(`${base}/accounts/${owner}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!accountRes.ok) return empty;
    const account = (await accountRes.json()) as HorizonAccountForSponsorship;

    const trustlineSponsors: Record<string, string | null> = {};
    for (const b of account.balances) {
      if (b.asset_type === "liquidity_pool_shares") continue;
      trustlineSponsors[horizonAssetToString(b)] = b.sponsor ?? null;
    }

    const signerSponsors: Record<string, string | null> = {};
    for (const s of account.signers) {
      signerSponsors[s.key] = s.sponsor ?? null;
    }

    const dataSponsors: Record<string, string | null> = {};
    for (const key of dataKeys) {
      try {
        const dataRes = await fetch(`${base}/accounts/${owner}/data/${key}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        dataSponsors[key] = dataRes.ok ? ((await dataRes.json()).sponsor ?? null) : null;
      } catch {
        return {
          ...empty,
          accountSponsor: account.sponsor ?? null,
          trustlineSponsors,
          signerSponsors,
        };
      }
    }

    const offerSponsors: Record<string, string | null> = {};
    if (needsOffers) {
      let nextUrl: string | null = `${base}/accounts/${owner}/offers?limit=200`;
      while (nextUrl) {
        const res: Response = await fetch(nextUrl, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) break;
        const page = (await res.json()) as HorizonOffersPage;
        const records = page._embedded?.records ?? [];
        for (const o of records) offerSponsors[String(o.id)] = o.sponsor ?? null;
        const nextHref = page._links?.next?.href;
        nextUrl = nextHref && records.length === 200 ? nextHref : null;
      }
    }

    return {
      accountSponsor: account.sponsor ?? null,
      trustlineSponsors,
      signerSponsors,
      offerSponsors,
      dataSponsors,
      fetchFailed: false,
    };
  } catch {
    return empty;
  }
}

interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  sponsor?: string;
  last_modified_time: string;
  claimants: Array<{ destination: string; predicate: Parameters<typeof parseClaimPredicate>[0] }>;
}

interface HorizonClaimableBalancesPage {
  _embedded?: { records?: HorizonClaimableBalance[] };
  _links?: { next?: { href?: string } };
}

async function fetchClaimableBalancesBySponsor(
  address: string,
  network: Network
): Promise<{ entries: SponsoredEntry[]; incomplete: boolean }> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { entries: [], incomplete: true };

  const entries: SponsoredEntry[] = [];
  let incomplete = false;
  let nextUrl: string | null =
    `${base}/claimable_balances?sponsor=${address}&limit=${CB_PAGE_LIMIT}`;

  while (nextUrl && entries.length < CB_MAX_TOTAL) {
    let res: Response;
    try {
      res = await fetch(nextUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      incomplete = true;
      break;
    }
    if (!res.ok) {
      incomplete = true;
      break;
    }

    const page = (await res.json()) as HorizonClaimableBalancesPage;
    const records = page._embedded?.records ?? [];

    // Defensive filter: trust the server-side ?sponsor= scoping, but never rely on it
    // exclusively - each record carries its own sponsor field too.
    for (const b of records) {
      if (b.sponsor === address) entries.push({ kind: "claimable_balance", balanceId: b.id });
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === CB_PAGE_LIMIT ? nextHref : null;
  }
  if (nextUrl) incomplete = true; // hit CB_MAX_TOTAL with more pages remaining

  return { entries, incomplete };
}

export async function enumerateSponsoredEntries(
  address: string,
  network: Network,
  numSponsoring: number
): Promise<{ sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean }> {
  const [{ candidates, incomplete: discoveryIncomplete }, cbResult] = await Promise.all([
    discoverSponsorshipCandidates(address, network),
    fetchClaimableBalancesBySponsor(address, network),
  ]);

  const ownersNeedingOffers = new Set<string>();
  const dataKeysByOwner = new Map<string, Set<string>>();
  const owners = new Set<string>();
  for (const c of candidates) {
    owners.add(c.owner);
    if (c.kind === "offer") ownersNeedingOffers.add(c.owner);
    if (c.kind === "data_entry") {
      if (!dataKeysByOwner.has(c.owner)) dataKeysByOwner.set(c.owner, new Set());
      dataKeysByOwner.get(c.owner)!.add(c.key);
    }
  }

  const liveStateByOwner = new Map<string, OwnerLiveState>(
    await Promise.all(
      Array.from(owners).map(
        async (owner): Promise<[string, OwnerLiveState]> => [
          owner,
          await fetchOwnerLiveState(
            owner,
            network,
            ownersNeedingOffers.has(owner),
            Array.from(dataKeysByOwner.get(owner) ?? [])
          ),
        ]
      )
    )
  );

  return reconcileSponsoredEntries(
    address,
    candidates,
    liveStateByOwner,
    cbResult.entries,
    discoveryIncomplete,
    cbResult.incomplete,
    numSponsoring
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/api && bun run type-check`
Expected: PASS. (`parseClaimPredicate` must already be exported from `horizon-adapter.ts` — confirmed present.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/stellar/sponsorship.ts apps/api/src/config/constants.ts
git commit -m "feat(api): add sponsorship enumeration io layer over horizon"
```

---

### Task 4: Wire into `getAccountState` and `getLiveAccountState`

**Files:**

- Modify: `apps/api/src/lib/stellar/account.ts`
- Modify: `apps/api/src/lib/stellar/account-live.ts`

**Interfaces:**

- Consumes: `enumerateSponsoredEntries` (Task 3).

- [ ] **Step 1: Wire into `account.ts` (RPC + SE-API path)**

In `apps/api/src/lib/stellar/account.ts`, add the import:

```typescript
import { enumerateSponsoredEntries } from "@/lib/stellar/sponsorship";
```

After the block that computes `numSponsoring` from the RPC ledger entry (the `try { const ext = accountEntry.ext(); ... } catch { ... }` block) and before the final `return`, add:

```typescript
const { sponsoredEntries, sponsorshipEnumerationIncomplete } = await enumerateSponsoredEntries(
  address,
  network,
  numSponsoring
);
```

In the returned `AccountState` object literal, add the two fields (near `numSponsoring`, matching the type's field order):

```typescript
    numSponsoring,
    sponsoredEntries,
    sponsorshipEnumerationIncomplete,
```

- [ ] **Step 2: Wire into `account-live.ts` (Horizon-live fallback path)**

In `apps/api/src/lib/stellar/account-live.ts`, add the import:

```typescript
import { enumerateSponsoredEntries } from "@/lib/stellar/sponsorship";
```

After `const numSubEntries = account.subentry_count;` and before the `return`, add:

```typescript
const numSponsoring = account.num_sponsoring ?? 0;
const { sponsoredEntries, sponsorshipEnumerationIncomplete } = await enumerateSponsoredEntries(
  address,
  network,
  numSponsoring
);
```

In the returned object, replace the inline `numSponsoring: account.num_sponsoring ?? 0,` with the now-precomputed variable, and add the two new fields:

```typescript
    numSponsoring,
    sponsoredEntries,
    sponsorshipEnumerationIncomplete,
```

- [ ] **Step 3: Full unit suite still passes**

Run: `cd apps/api && bun run type-check && bun test tests/unit`
Expected: PASS. No existing test constructs `AccountState` by calling `getAccountState`/`getLiveAccountState` directly (confirmed during investigation — they're exercised only through fixtures), so this step is a compile/type check plus a regression pass over everything Task 1 touched.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/stellar/account.ts apps/api/src/lib/stellar/account-live.ts
git commit -m "feat(api): populate sponsoredEntries in both account-state read paths"
```

---

### Task 5: Testnet integration test tier + the required integration test

**Files:**

- Create: `apps/api/tests/integration/sponsorship.integration.test.ts`
- Modify: `apps/api/package.json`
- Modify: `CONTRIBUTING.md`

**Interfaces:**

- Consumes: `getAccountState` (`@/lib/stellar/account`), `@stellar/stellar-sdk` (Friendbot funding + real tx submission).

- [ ] **Step 1: Split the test script so this tier never runs in default `bun test` / CI**

In `apps/api/package.json`, change:

```json
    "test": "bun test tests",
```

to:

```json
    "test": "bun test tests/unit tests/e2e",
    "test:integration": "bun test tests/integration",
```

This mirrors `apps/web`'s existing `test` (unit-only, CI-run) vs. `test:e2e` (Playwright, testnet, not run by CI's `test` step) split — CI's `bun run --filter '@lumenwipe/api' test` will not pick up `tests/integration/`.

- [ ] **Step 2: Document the new tier**

In `CONTRIBUTING.md` §8 ("Testing requirements"), after the "End-to-end tests" subsection, add:

```markdown
### Integration tests (`tests/integration/`)

Run manually with `bun run test:integration` (apps/api only) - not part of `bun test`
or CI, since it makes real Friendbot/testnet Horizon calls. For server-side-only logic
with no UI to drive through Playwright (e.g. account-state enumeration), this is the
tier that actually touches testnet, matching the integration tier docs/architecture.md
§17 already describes but that had no directory on disk until this tier existed.
```

- [ ] **Step 3: Write the integration test**

Create `apps/api/tests/integration/sponsorship.integration.test.ts`:

```typescript
import { test, expect } from "bun:test";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";
import { getAccountState } from "@/lib/stellar/account";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

test("getAccountState › reports a real sponsored trustline created on testnet", async () => {
  const server = new Horizon.Server(HORIZON_URL);
  const sponsor = Keypair.random();
  const sponsored = Keypair.random();
  const issuer = Keypair.random();

  await Promise.all([
    fund(sponsor.publicKey()),
    fund(sponsored.publicKey()),
    fund(issuer.publicKey()),
  ]);
  const asset = new Asset("LWTEST", issuer.publicKey());

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sponsored.publicKey(),
        source: sponsor.publicKey(),
      })
    )
    .addOperation(Operation.changeTrust({ asset, source: sponsored.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }))
    .setTimeout(60)
    .build();
  tx.sign(sponsor);
  tx.sign(sponsored);
  await server.submitTransaction(tx);

  // Horizon indexing lag for the account this test's assertions read through.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const state = await getAccountState(sponsor.publicKey(), "testnet");

  expect(state.numSponsoring).toBe(1);
  expect(state.sponsorshipEnumerationIncomplete).toBe(false);
  expect(state.sponsoredEntries).toContainEqual({
    kind: "trustline",
    owner: sponsored.publicKey(),
    asset: `LWTEST:${issuer.publicKey()}`,
  });
}, 30000);
```

- [ ] **Step 4: Run it (manually — not part of the standard verification loop for this plan)**

Run: `cd apps/api && bun run test:integration`
Expected: PASS against real testnet (requires network access; may take several seconds for Friendbot funding + submission + indexing).

- [ ] **Step 5: Verify the default test run excludes it**

Run: `cd apps/api && bun run test`
Expected: PASS, and the integration test does not appear in the output (only `tests/unit` and `tests/e2e` ran).

- [ ] **Step 6: Commit**

```bash
git add apps/api/tests/integration/sponsorship.integration.test.ts apps/api/package.json CONTRIBUTING.md
git commit -m "test(api): add testnet integration tier and sponsorship enumeration test"
```

---

### Task 6: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full repo matrix**

Run: `bun run --filter '@lumenwipe/types' type-check`
Run: `cd apps/api && bun run type-check && bun run lint && bun test`
Run: `bun run --filter '@lumenwipe/web' type-check` (confirms the untouched `apps/web` duplicate type doesn't now conflict with anything — it shouldn't, since it's structurally separate)
Run: `bun run format` (Prettier, repo-wide)

Expected: all PASS, no diff from `format` beyond what was already written by hand.

- [ ] **Step 2: Confirm no stray files**

Run: `git status --short`
Expected: only the files this plan touched.

---

## Self-review notes

- **Spec coverage**: every acceptance-criteria bullet has a task — investigation-documented-on-the-issue (Task 1), `SponsoredEntry` + `AccountState` (Task 1), population in `getAccountState` (Task 4; also `getLiveAccountState`, since the issue's own "existing `subEntryMismatch` pattern" reference computes that field identically in both read paths, and skipping one would silently drop the field through `read-account.ts`'s fallback), `sponsorshipEnumerationIncomplete` (Task 2/3), the three required unit-test scenarios plus extras (Task 2), the testnet integration test (Task 5), and green `type-check`/`lint`/`test` (Task 6).
- **No blocker/step changes**: confirmed `tx-builder/index.ts` is never touched by this plan.
- **Type consistency**: `SponsoredEntry`'s field names (`owner`, `asset`, `offerId`, `name`, `signerKey`, `balanceId`) are used identically across Task 1 (type definition), Task 2 (reconciliation + its tests), Task 3 (I/O layer construction), and Task 5 (integration test assertion).
