# Close-account REST API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the stateless `/v1/{network}/close/*` REST API (plan, transactions, submit) plus a pure, verifiable `intent` serializer, reusing the existing pure `tx-builder`, without changing the current browser flow.

**Architecture:** Thin Next.js route handlers over new pure modules. Reads and orchestration that today live in `hooks/useStepExecution.ts` + `lib/stellar/step-engine.ts` are wrapped server-side; the pure `lib/stellar/tx-builder/*` and `buildPlan` are reused untouched. The API only ever returns unsigned XDR and never accepts a secret. Each transaction carries a structured `intent` decoded from its XDR (same code the future SDK `verify()` will reuse).

**Tech Stack:** Next.js App Router route handlers, `@stellar/stellar-sdk` v16, Bun test runner, `node:crypto` for `planHash`.

**Design reference:** `docs/plans/2026-06-21-close-account-api-design.md`. Read it before starting.

**Out of scope (separate follow-up plans):** the SDK and client-side `verify()`; refactoring `useStepExecution.ts` to consume the API; DeFi exit adapters and the `frontier` multi-call path; auth / rate-limiting.

**Before you start — read these files:**
- `types/plan.ts` (`PlannedStep`, `StepType`, `AssetDisposition = "convert" | "issuer"`, `PlanBlocker`, `BuildPlanResult`)
- `types/account.ts` (`AccountState`, `Trustline`, `ClaimableBalance`, `AccountSigner` — verify exact field names; this plan assumes `Trustline { asset, code, issuer, balance, authorized }`)
- `lib/stellar/tx-builder/index.ts` (`buildPlan`, `computeNeedsSignerNormalization`)
- `lib/stellar/step-engine.ts` (`buildStepXdrForPlan`, `StepBuildContext`)
- `lib/stellar/tx-builder/fused-close.ts` (`buildFusedCloseTx`)
- `app/api/[network]/account/[address]/route.ts` (route handler pattern)
- `config/networks.ts` (`isValidNetwork`, `NETWORK_PASSPHRASES`), `lib/utils/validation.ts` (`isValidGAddress`, `isValidMemo`)

**Conventions:** strict TS, no `any`, explicit return types on exports, double quotes, semicolons, printWidth 100. Conventional Commits. All API human-readable strings in English. Run `bun type-check && bun lint && bun run test` before every commit.

---

### Task 1: API contract types

**Files:**
- Create: `types/close-api.ts`

**Step 1: Write the types**

```typescript
import type { StepType } from "@/types/plan";

export type CloseApiStatus = "ready" | "needs_decisions" | "blocked" | "complete";

export interface QuoteInfo {
  estimatedReceive: string;
  path: string[];
  source: "soroswap" | "sdex";
  expiresAtLedger: number;
}

export interface DecisionOption {
  id: string; // e.g. "convert_to_xlm" | "return_to_issuer" | "acknowledged"
  recommended?: boolean;
  quote?: QuoteInfo;
  note?: string; // English only
}

export interface DecisionPoint {
  id: string; // stable, e.g. "asset:USDC-GISSUER..."
  type: "asset_disposition" | "confirmation" | "choice";
  subject: Record<string, unknown>;
  options: DecisionOption[];
  default: string;
  required: boolean;
}

export interface DecisionAnswer {
  id: string;
  choice: string;
  params?: { maxSlippageBps?: number };
}

export interface ExecutionTxBreakdown {
  order: number;
  covers: StepType[];
  reason?: "op_batch" | "defi_dependency";
}

export interface PlanResponse {
  planHash: string;
  status: CloseApiStatus;
  steps: unknown[]; // PlannedStep[] serialized; reuse types/plan PlannedStep
  decisionPoints: DecisionPoint[];
  blockers: { code: string; message: string; helpUrl?: string }[];
  estimate: { feeStroops: string; freedReserveXlm: string };
  execution: { estimatedTransactionCount: number; transactions: ExecutionTxBreakdown[] };
}

export type IntentOperation =
  | { type: "path_payment_strict_send"; sendAsset: string; sendAmount: string;
      destination: string; destAsset: string; destMin: string; path: string[] }
  | { type: "payment"; destination: string; asset: string; amount: string }
  | { type: "change_trust"; asset: string; limit: string }
  | { type: "account_merge"; destination: string }
  | { type: "manage_sell_offer"; offerId: string; amount: string }
  | { type: "manage_data"; name: string; value: string | null }
  | { type: "set_options"; summary: string }
  | { type: "claim_claimable_balance"; balanceId: string };

export interface TxIntent {
  summary: string;
  source: string;
  fee: string;
  memo: string | null;
  guarantees: {
    mergeDestination: string | null;
    paymentsOnlyTo: string[];
    minXlmFromConversions: string | null;
  };
  operations: IntentOperation[];
}

export interface CloseTransaction {
  id: string;
  order: number;
  dependsOn: string[];
  xdr: string;
  networkPassphrase: string;
  sourceSequence: string;
  validUntilLedger: number;
  covers: StepType[];
  intent: TxIntent;
}

export interface TransactionsResponse {
  planHash: string;
  status: CloseApiStatus;
  transactions: CloseTransaction[];
  remaining: { steps: number; requiresAnotherCall: boolean };
}
```

**Step 2: Verify it type-checks**

Run: `bun type-check`
Expected: PASS (no errors).

**Step 3: Commit**

```bash
git add types/close-api.ts
git commit -m "feat(backend): add close-account API contract types"
```

---

### Task 2: Intent serializer (decode XDR → normalized intent)

This is the core new pure module. It decodes an unsigned transaction envelope and produces a `TxIntent`. No network.

**Files:**
- Create: `lib/stellar/intent/serialize.ts`
- Test: `tests/unit/intent-serialize.test.ts`

**Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { Account, Asset, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";

const SRC = "GAAAA...";   // replace with Keypair.random().publicKey() at top of file
const DEST = "GBBBB...";
const ISSUER = "GCCCC...";

function buildSampleXdr(): string {
  const account = new Account(SRC, "100");
  const b = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }))
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .setTimeout(300);
  return b.build().toEnvelope().toXDR("base64");
}

test("intentFromXdr normalizes change_trust and account_merge", () => {
  const intent = intentFromXdr(buildSampleXdr(), Networks.TESTNET);
  expect(intent.source).toBe(SRC);
  expect(intent.operations).toContainEqual({ type: "change_trust", asset: `USDC:${ISSUER}`, limit: "0" });
  expect(intent.operations).toContainEqual({ type: "account_merge", destination: DEST });
  expect(intent.guarantees.mergeDestination).toBe(DEST);
});
```

Use `Keypair.random().publicKey()` for `SRC`/`DEST`/`ISSUER` at the top so the test is self-contained.

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/intent-serialize.test.ts`
Expected: FAIL with "intentFromXdr is not a function".

**Step 3: Write the implementation**

```typescript
import { Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { IntentOperation, TxIntent } from "@/types/close-api";

function assetToString(asset: { isNative(): boolean; getCode(): string; getIssuer(): string }): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}

function normalizeOp(op: Operation): IntentOperation | null {
  switch (op.type) {
    case "pathPaymentStrictSend":
      return { type: "path_payment_strict_send", sendAsset: assetToString(op.sendAsset),
        sendAmount: op.sendAmount, destination: op.destination, destAsset: assetToString(op.destAsset),
        destMin: op.destMin, path: op.path.map(assetToString) };
    case "payment":
      return { type: "payment", destination: op.destination, asset: assetToString(op.asset), amount: op.amount };
    case "changeTrust":
      return { type: "change_trust", asset: assetToString(op.line as never), limit: op.limit ?? "0" };
    case "accountMerge":
      return { type: "account_merge", destination: op.destination };
    case "manageSellOffer":
      return { type: "manage_sell_offer", offerId: String(op.offerId), amount: op.amount };
    case "manageData":
      return { type: "manage_data", name: op.name, value: op.value ? op.value.toString("base64") : null };
    case "setOptions":
      return { type: "set_options", summary: "Adjust signers and/or thresholds" };
    case "claimClaimableBalance":
      return { type: "claim_claimable_balance", balanceId: op.balanceId };
    default:
      return null;
  }
}

export function intentFromXdr(xdr: string, networkPassphrase: string): TxIntent {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;
  const operations = tx.operations.map(normalizeOp).filter((o): o is IntentOperation => o !== null);

  const merge = operations.find((o) => o.type === "account_merge");
  const paymentsOnlyTo = [
    ...new Set(
      operations.flatMap((o) =>
        o.type === "payment" ? [o.destination] :
        o.type === "path_payment_strict_send" ? [o.destination] : []
      )
    ),
  ];
  const minXlmFromConversions = operations
    .filter((o): o is Extract<IntentOperation, { type: "path_payment_strict_send" }> =>
      o.type === "path_payment_strict_send")
    .reduce<string | null>((acc, o) => acc === null ? o.destMin : String(Number(acc) + Number(o.destMin)), null);

  return {
    summary: "", // filled by the transactions builder which knows the plan steps
    source: tx.source,
    fee: tx.fee,
    memo: tx.memo?.value ? tx.memo.value.toString() : null,
    guarantees: {
      mergeDestination: merge && merge.type === "account_merge" ? merge.destination : null,
      paymentsOnlyTo,
      minXlmFromConversions,
    },
    operations,
  };
}
```

Note: confirm v16 op field names (`op.sendAsset`, `op.line`, `op.offerId`) against the SDK types as you go; adjust casts to avoid `any` (use `unknown` + narrowing if needed).

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/intent-serialize.test.ts`
Expected: PASS.

**Step 5: Add a fee-bump / multi-op conversion test**

Add a test that builds a tx with a `pathPaymentStrictSend` + `changeTrust` + `accountMerge` and asserts `guarantees.minXlmFromConversions` equals the `destMin`, and `paymentsOnlyTo` contains the source (self-conversion destination).

Run: `bun test tests/unit/intent-serialize.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add lib/stellar/intent/serialize.ts tests/unit/intent-serialize.test.ts
git commit -m "feat(backend): add pure XDR-to-intent serializer"
```

---

### Task 3: Decision derivation and resolution

Derive `DecisionPoint[]` from an `AccountState`, and resolve `DecisionAnswer[]` into the `assetDispositions` record `StepBuildContext` expects.

**Files:**
- Create: `lib/close-api/decisions.ts`
- Test: `tests/unit/close-api-decisions.test.ts`

**Step 1: Write the failing test**

```typescript
import { test, expect } from "bun:test";
import { deriveDecisionPoints, resolveDispositions } from "@/lib/close-api/decisions";
import type { AccountState } from "@/types/account";

// reuse a makeAccount helper modeled on tests/unit/buildPlan.test.ts
test("a trustline with a balance produces an asset_disposition decision point", () => {
  const account = makeAccount({
    trustlines: [{ asset: `USDC:${ISSUER}`, code: "USDC", issuer: ISSUER, balance: "10", authorized: true }],
  });
  const points = deriveDecisionPoints(account, { [`USDC:${ISSUER}`]: true /* convertible */ });
  expect(points).toHaveLength(1);
  expect(points[0].type).toBe("asset_disposition");
  expect(points[0].id).toBe(`asset:USDC-${ISSUER}`);
  expect(points[0].options.map((o) => o.id)).toEqual(["convert_to_xlm", "return_to_issuer"]);
});

test("non-convertible asset offers only return_to_issuer", () => {
  const account = makeAccount({
    trustlines: [{ asset: `FOO:${ISSUER}`, code: "FOO", issuer: ISSUER, balance: "5", authorized: true }],
  });
  const points = deriveDecisionPoints(account, { [`FOO:${ISSUER}`]: false });
  expect(points[0].options.map((o) => o.id)).toEqual(["return_to_issuer"]);
  expect(points[0].default).toBe("return_to_issuer");
});

test("resolveDispositions maps answers to the assetDispositions record", () => {
  const dispositions = resolveDispositions(
    [{ id: `asset:USDC-${ISSUER}`, choice: "convert_to_xlm" }],
    [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`USDC:${ISSUER}`]: "convert" });
});
```

**Step 2: Run to verify it fails**

Run: `bun test tests/unit/close-api-decisions.test.ts`
Expected: FAIL ("deriveDecisionPoints is not a function").

**Step 3: Implement**

```typescript
import type { AccountState } from "@/types/account";
import type { AssetDisposition } from "@/types/plan";
import type { DecisionPoint, DecisionAnswer } from "@/types/close-api";

const decisionId = (asset: string): string => `asset:${asset.replace(":", "-")}`;

export function deriveDecisionPoints(
  account: AccountState,
  convertibility: Record<string, boolean>
): DecisionPoint[] {
  return account.trustlines
    .filter((tl) => Number(tl.balance) > 0)
    .map((tl) => {
      const convertible = convertibility[tl.asset] ?? false;
      const options = convertible
        ? [
            { id: "convert_to_xlm", recommended: true },
            { id: "return_to_issuer", note: "Sends the balance back to the issuer; you receive no XLM." },
          ]
        : [{ id: "return_to_issuer", note: "No conversion route exists; the balance is returned to the issuer." }];
      return {
        id: decisionId(tl.asset),
        type: "asset_disposition" as const,
        subject: { kind: "trustline", asset: tl.asset, balance: tl.balance, convertible },
        options,
        default: convertible ? "convert_to_xlm" : "return_to_issuer",
        required: true,
      };
    });
}

export function resolveDispositions(
  answers: DecisionAnswer[],
  assetsById: { id: string; asset: string }[]
): Record<string, AssetDisposition> {
  const byId = new Map(assetsById.map((a) => [a.id, a.asset]));
  const out: Record<string, AssetDisposition> = {};
  for (const a of answers) {
    const asset = byId.get(a.id);
    if (!asset) continue;
    if (a.choice === "convert_to_xlm") out[asset] = "convert";
    else if (a.choice === "return_to_issuer") out[asset] = "issuer";
  }
  return out;
}
```

Add the `makeAccount` helper at the top of the test (copy the shape from `tests/unit/buildPlan.test.ts`).

**Step 4: Run to verify it passes**

Run: `bun test tests/unit/close-api-decisions.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/close-api/decisions.ts tests/unit/close-api-decisions.test.ts
git commit -m "feat(backend): derive and resolve close-account decision points"
```

---

### Task 4: Plan response mapper (+ planHash)

Map `BuildPlanResult` + decision points into a `PlanResponse`, compute `planHash`, and derive the `execution` breakdown (group consecutive `PlannedStep`s into the transactions a `mode:"all"` build would produce).

**Files:**
- Create: `lib/close-api/plan-response.ts`
- Test: `tests/unit/close-api-plan-response.test.ts`

**Step 1: Write failing tests** for:
- `planHash` is stable for the same `(source, destination, sorted decisions, snapshotLedger)` and changes when any of them change.
- `toExecutionBreakdown(steps)` returns `estimatedTransactionCount: 1` and one entry covering all step types when the account is fused-eligible (no DeFi).
- `status` is `"blocked"` when blockers are non-empty, `"needs_decisions"` when decision points are unresolved, else `"ready"`.

**Step 2: Run** → FAIL.

**Step 3: Implement** — `planHash` via `node:crypto`:

```typescript
import { createHash } from "node:crypto";
import type { BuildPlanResult, PlannedStep } from "@/types/plan";
import type { DecisionAnswer, DecisionPoint, PlanResponse, ExecutionTxBreakdown } from "@/types/close-api";

export function computePlanHash(input: {
  source: string; destination: string | null; decisions: DecisionAnswer[]; snapshotLedger: number;
}): string {
  const canonical = JSON.stringify({
    source: input.source,
    destination: input.destination,
    decisions: [...input.decisions].sort((a, b) => a.id.localeCompare(b.id)),
    snapshotLedger: input.snapshotLedger,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function toExecutionBreakdown(steps: PlannedStep[]): {
  estimatedTransactionCount: number; transactions: ExecutionTxBreakdown[];
} {
  // Phase 1: no DeFi dependencies, so the whole plan is one fused transaction.
  if (steps.length === 0) return { estimatedTransactionCount: 0, transactions: [] };
  return {
    estimatedTransactionCount: 1,
    transactions: [{ order: 0, covers: [...new Set(steps.map((s) => s.type))] }],
  };
}
// + assemblePlanResponse(buildResult, decisionPoints, unresolved, planHash, estimate) -> PlanResponse
```

**Step 4: Run** → PASS.

**Step 5: Commit**

```bash
git add lib/close-api/plan-response.ts tests/unit/close-api-plan-response.test.ts
git commit -m "feat(backend): map build plan to API response with stable planHash"
```

---

### Task 5: `POST /v1/{network}/close/plan` route handler

Thin handler: validate → read account state → check convertibility (best-effort) → `buildPlan` → derive decision points → `assemblePlanResponse`.

**Files:**
- Create: `app/api/v1/[network]/close/plan/route.ts`
- Test: `tests/unit/close-plan-route.test.ts` (call the exported `POST` with a stubbed account read)

**Step 1: Write the failing test** — import `POST`, pass a `NextRequest`-like object with a JSON body for a source with one trustline; assert `200`, `status: "ready" | "needs_decisions"`, and that `decisionPoints` is populated. Stub the account read (extract the read into a small injectable function or mock the module per the repo's test style).

**Step 2: Run** → FAIL.

**Step 3: Implement** following `app/api/[network]/account/[address]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { deriveDecisionPoints } from "@/lib/close-api/decisions";
import { assemblePlanResponse, computePlanHash } from "@/lib/close-api/plan-response";
// ... validate network + body.source; 400 on bad input, 404 on AccountNotFoundError.
// destination optional; mediatorRequired = false for phase 1 unless destination is a known exchange.
// convertibility: best-effort — phase 1 may mark all balances convertible=false until /paths wired in.
```

Return `NextResponse.json(planResponse, { headers: { "Cache-Control": "no-store" } })`. Map `AccountNotFoundError` → `404`, validation → `400/422`, never leak SDK errors.

**Step 4: Run** → PASS. Then `bun type-check && bun lint`.

**Step 5: Commit**

```bash
git add app/api/v1/[network]/close/plan/route.ts tests/unit/close-plan-route.test.ts
git commit -m "feat(backend): add POST /v1/{network}/close/plan endpoint"
```

---

### Task 6: `POST /v1/{network}/close/transactions` (mode: "all")

Resolve decisions → build the fused transaction via the existing builder → attach the decoded `intent`. Phase 1 returns a single transaction (`remaining.steps = 0`).

**Files:**
- Create: `lib/close-api/build-transactions.ts` (pure-ish orchestration; reuses `buildStepXdrForPlan`/`buildFusedCloseTx`)
- Create: `app/api/v1/[network]/close/transactions/route.ts`
- Test: `tests/unit/close-api-build-transactions.test.ts` (testnet integration may live in e2e — see Task 8)

**Step 1: Write the failing test** for `build-transactions`: given an `AccountState`, destination, and resolved dispositions, it returns one `CloseTransaction` whose `intent.guarantees.mergeDestination` equals the destination and whose `covers` includes `"MERGE"`. (Build against a fixed sequence via `new Account(src, seq)` to keep it offline.)

**Step 2: Run** → FAIL.

**Step 3: Implement** — assemble the fused close (reuse `buildFusedCloseTx` from `lib/stellar/tx-builder/fused-close.ts`), then:

```typescript
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { NETWORK_PASSPHRASES } from "@/config/networks";
// const xdr = buildFusedCloseTx(sdkAccount, fusedInput, network);
// const intent = { ...intentFromXdr(xdr, NETWORK_PASSPHRASES[network]), summary: <built from covered steps> };
// return [{ id: "tx-1", order: 0, dependsOn: [], xdr, networkPassphrase, sourceSequence, validUntilLedger, covers, intent }];
```

**Route handler:** validate network + body (`source`, `destination`, `decisions`). Re-read live state. Require every decision point resolved → else `422` with the offending points. Re-quote convertibles; on drift → `409 quote_drifted`. If `planHash` supplied and the snapshot changed → `409 state_changed`. Otherwise return `TransactionsResponse`.

**Step 4: Run** → PASS. Then `bun type-check && bun lint`.

**Step 5: Commit**

```bash
git add lib/close-api/build-transactions.ts app/api/v1/[network]/close/transactions/route.ts tests/unit/close-api-build-transactions.test.ts
git commit -m "feat(backend): add POST /v1/{network}/close/transactions endpoint"
```

---

### Task 7: `POST /v1/{network}/submit`

**Files:**
- Create: `app/api/v1/[network]/submit/route.ts`
- Test: `tests/unit/close-submit-route.test.ts` (validation only; real submission covered in e2e)

**Step 1–2:** failing test: posting a non-string / missing `signedXdr` → `400`; posting an unsigned-looking XDR is still accepted (signature validity is the network's job) but a malformed base64 → `400`.

**Step 3:** Implement wrapping `submitAndWait` from `lib/stellar/submit.ts`. Never accept a secret; body is `{ signedXdr }` only. Map upstream failure → `502`.

**Step 4:** Run → PASS; `bun type-check && bun lint`.

**Step 5: Commit**

```bash
git add app/api/v1/[network]/submit/route.ts tests/unit/close-submit-route.test.ts
git commit -m "feat(backend): add POST /v1/{network}/submit endpoint"
```

---

### Task 8: Testnet integration test (build → sign → submit via API)

**Files:**
- Create: `tests/e2e/close-api.spec.ts`

**Step 1: Write the test** (mirrors `tests/e2e/single-tx-flow.spec.ts` setup): fund a fresh testnet account with friendbot; `POST /v1/testnet/close/plan` → assert `status` and `execution.estimatedTransactionCount === 1`; `POST /v1/testnet/close/transactions` with `destination` = a second funded account; sign the returned `xdr` locally with the source `Keypair`; `POST /v1/testnet/submit`; then assert on-chain (via Horizon/RPC) that the source account no longer exists.

**Step 2: Run**

Run: `bun test:e2e -- close-api.spec.ts`
Expected: PASS against testnet (never mainnet).

**Step 3: Commit**

```bash
git add tests/e2e/close-api.spec.ts
git commit -m "test(backend): testnet integration for the close-account API"
```

---

### Task 9: Final gate

**Step 1:** Run the full gate.

Run: `bun type-check && bun lint && bun run test`
Expected: all PASS, zero lint errors.

**Step 2:** Run e2e.

Run: `bun run test:e2e`
Expected: all PASS (existing 14 + the new close-api spec).

**Step 3:** Open the PR (flag it security-sensitive — it touches transaction construction). Do not merge without review.

---

## Verification checklist (per `superpowers:verification-before-completion`)

- [ ] `bun type-check` clean
- [ ] `bun lint` zero errors
- [ ] `bun run test` all pass (incl. new intent / decisions / plan-response / route tests)
- [ ] `bun run test:e2e` all pass on testnet
- [ ] API returns unsigned XDR only; no endpoint accepts a secret key
- [ ] `intent.guarantees.mergeDestination` always equals the requested destination in tests
- [ ] All API strings are English; identifiers/codes untranslated
- [ ] `tx-builder/` still pure (no network imports added)
