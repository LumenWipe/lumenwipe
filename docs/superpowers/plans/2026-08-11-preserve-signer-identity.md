# Preserve signer identity through the close pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [LumenWipe/lumenwipe#98](https://github.com/LumenWipe/lumenwipe/issues/98) — sub-issue 1/6 of the multisig-hardening epic (#97), per `docs/superpowers/specs/2026-08-11-multisig-hardening-design.md`.

**Goal:** Stop collapsing a `SetOptions` signer-removal operation to a bare weight number. Carry the signer's real type and key (ed25519, hash(x), pre-auth-tx, ed25519 signed-payload) through the API's intent serializer, the web's independent trust-anchor decoder, and `verify()`'s `CloseExpectation`, so `verify()` can check a `SetOptions` op against the account's _actual_ signer set instead of judging the op in isolation. Foundation for the multisig epic; no user-facing behavior changes beyond a new rejection path for an op touching a signer that isn't really on the account.

**Architecture:** Two independent, already-duplicated decode pipelines exist by design — `apps/api/src/lib/stellar/intent/serialize.ts` (server-declared `intent` on `CloseTransaction`, informational) and `apps/web/lib/stellar/intent/serialize.ts` (the client's own independent re-decode of the raw XDR, which `verify()` actually trusts). Both currently reduce a `SetOptions` signer to a number or a canned string. Both get the same fix: decode the SDK's discriminated `Signer` union to the same `{ type, key, weight }` shape `AccountSigner` already uses elsewhere in the codebase (`packages/types/src/account.ts`), re-encoding the raw `Buffer` the SDK returns for hash(x)/pre-auth-tx signers to strkey via `StrKey.encodeSha256Hash`/`StrKey.encodePreAuthTx` — exactly mirroring the existing `parseXdrSigner` helper in `apps/api/src/lib/stellar/account.ts:27-53`, so the resulting key strings are directly comparable to `AccountState.signers[].key`. `verify()`'s `CloseExpectation` then gains the account's real `signers`/`thresholds` (already read into `AccountState` and already sitting in the web `accountState` store — no new read), and the `set_options` check in `assertCloseIntent` uses it to confirm the touched signer is one that genuinely exists on the account, not just that its weight is 0.

**Tech Stack:** TypeScript, `@stellar/stellar-sdk` 16.0.1 (server-side in `apps/api`, client-side decode-only in `apps/web`), Bun test runner.

## Global Constraints

- Strict TypeScript, no `any` (use `unknown` + a guard); explicit return types on exported functions.
- Prettier formatting: double quotes, semicolons, printWidth 100 — run `bun run format` if unsure.
- Comments only when the _why_ is non-obvious (this codebase already does this consistently — match the existing tone).
- Bug fixes/behavior changes require a unit test; this touches the trust anchor (`verify()`), so **every** new check needs both a positive and negative test.
- `bun type-check && bun lint && bun test` must pass across `apps/api`, `apps/web`, and `packages/types` before this is done.
- Never mix `require()`/`import` of `@stellar/stellar-sdk` in the same runtime (not at risk here — both serialize.ts files already import it correctly, one per app).
- `apps/web`'s `apps/web/types/close-api.ts` and `apps/web/types/account.ts` are **intentional, pre-existing local duplicates** of `packages/types`' shapes, used only by the trust-anchor module (`verify.ts`/`intent/serialize.ts`) and its tests — every other web consumer imports from `@lumenwipe/sdk`/`@lumenwipe/types`. Do not consolidate them in this plan; that's a separate, out-of-scope refactor. Keep both copies in sync for the fields this issue touches.
- Security-sensitive: this changes `CloseExpectation`, the trust anchor's data model. Flag the PR for a second reviewer per CLAUDE.md.

---

## Task 1: API-side signer identity (`packages/types` + `apps/api`)

**Files:**

- Modify: `packages/types/src/close-api.ts` (the `set_options` variant of `IntentOperation`)
- Modify: `apps/api/src/lib/stellar/intent/serialize.ts:1-2,45-46`
- Modify: `apps/api/tests/unit/intent-serialize.test.ts`

**Interfaces:**

- Consumes: `AccountSigner` from `packages/types/src/account.ts` (`{ key: string; weight: number; type: "ed25519_public_key" | "hash_x" | "preauth_tx" | "ed25519_signed_payload" }`), already exported by `@lumenwipe/types`.
- Produces: `IntentOperation`'s `set_options` variant now carries `signer: AccountSigner | null` instead of `summary: string`. `intentFromXdr` (api) populates it from the decoded XDR. This is the type Task 2 mirrors locally in `apps/web`.

- [ ] **Step 1: Extend the shared `set_options` type**

In `packages/types/src/close-api.ts`, add the import and replace the `set_options` member:

```ts
import type { StepType } from "./plan";
import type { AccountSigner } from "./account";
```

```ts
  | {
      type: "set_options";
      // The signer a SetOptions op touches, decoded to its real type/key (not just weight),
      // so verify() can check it against the account's actual signer set. Null when the op
      // only touches thresholds/master weight and carries no signer field.
      signer: AccountSigner | null;
      masterWeight: number | null;
      lowThreshold: number | null;
      medThreshold: number | null;
      highThreshold: number | null;
    }
```

- [ ] **Step 2: Type-check the shared package in isolation**

Run: `cd packages/types && bun run type-check`
Expected: FAIL — `apps/api/src/lib/stellar/intent/serialize.ts` still returns the old `{ type: "set_options", summary: ... }` shape, so `apps/api`'s own type-check (not this one) will fail once Step 4 runs; this step should actually PASS since `close-api.ts` alone is self-consistent. Run it to confirm the type file itself compiles clean before moving on.

- [ ] **Step 3: Write the failing decode tests**

Add to the end of `apps/api/tests/unit/intent-serialize.test.ts` (add `StrKey, xdr` to the existing `@stellar/stellar-sdk` import):

```ts
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Keypair,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
```

```ts
test("intentFromXdr decodes an ed25519 signer removal with its type and key", () => {
  const signerKey = Keypair.random().publicKey();
  const txXdr = txWith(
    Operation.setOptions({ signer: { ed25519PublicKey: signerKey, weight: 0 } })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "ed25519_public_key", key: signerKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a hash(x) signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { sha256Hash: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "hash_x", key: StrKey.encodeSha256Hash(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a pre-auth-tx signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { preAuthTx: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "preauth_tx", key: StrKey.encodePreAuthTx(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes an ed25519 signed-payload (CAP-40) signer removal", () => {
  const payloadXdr = new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("cafebabe", "hex"),
  }).toXDR();
  const signedPayloadKey = StrKey.encodeSignedPayload(payloadXdr);
  const txXdr = txWith(
    Operation.setOptions({ signer: { ed25519SignedPayload: signedPayloadKey, weight: 0 } })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "ed25519_signed_payload", key: signedPayloadKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a set_options op with no signer field as signer: null", () => {
  const txXdr = txWith(
    Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: null,
    masterWeight: null,
    lowThreshold: 0,
    medThreshold: 1,
    highThreshold: 1,
  });
});
```

- [ ] **Step 4: Run the new tests to confirm they fail**

Run: `cd apps/api && bun test tests/unit/intent-serialize.test.ts`
Expected: FAIL — `intentFromXdr` still returns `{ type: "set_options", summary: "..." }`, and the file won't even type-check against the Step 1 type change.

- [ ] **Step 5: Implement the decode**

In `apps/api/src/lib/stellar/intent/serialize.ts`, update the imports (line 1-2):

```ts
import { TransactionBuilder, StrKey, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { AccountSigner, IntentOperation, TxIntent } from "@lumenwipe/types";
```

Add a helper above `normalizeOp` (after `assetToString`):

```ts
type DecodedSetOptions = Extract<Transaction["operations"][number], { type: "setOptions" }>;

// Decodes a SetOptions signer to the same { type, key, weight } shape AccountSigner uses
// elsewhere (apps/api/src/lib/stellar/account.ts:27-53), so verify() can match it against the
// account's real signer set. The SDK decodes hash(x)/pre-auth-tx signers to raw buffers (unlike
// ed25519 and ed25519-signed-payload, which it already strkey-encodes) - re-encode them so every
// signer type produces a comparable strkey.
function decodeSigner(signer: NonNullable<DecodedSetOptions["signer"]>): AccountSigner {
  if ("ed25519PublicKey" in signer) {
    return {
      type: "ed25519_public_key",
      key: signer.ed25519PublicKey,
      weight: Number(signer.weight),
    };
  }
  if ("sha256Hash" in signer) {
    return {
      type: "hash_x",
      key: StrKey.encodeSha256Hash(signer.sha256Hash),
      weight: Number(signer.weight),
    };
  }
  if ("preAuthTx" in signer) {
    return {
      type: "preauth_tx",
      key: StrKey.encodePreAuthTx(signer.preAuthTx),
      weight: Number(signer.weight),
    };
  }
  return {
    type: "ed25519_signed_payload",
    key: signer.ed25519SignedPayload,
    weight: Number(signer.weight),
  };
}
```

Replace line 45-46 (`case "setOptions": return { type: "set_options", summary: ... };`):

```ts
    case "setOptions":
      return {
        type: "set_options",
        signer: op.signer ? decodeSigner(op.signer) : null,
        masterWeight: op.masterWeight == null ? null : Number(op.masterWeight),
        lowThreshold: op.lowThreshold == null ? null : Number(op.lowThreshold),
        medThreshold: op.medThreshold == null ? null : Number(op.medThreshold),
        highThreshold: op.highThreshold == null ? null : Number(op.highThreshold),
      };
```

- [ ] **Step 6: Run the tests again to confirm they pass**

Run: `cd apps/api && bun test tests/unit/intent-serialize.test.ts`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 7: Type-check and lint the api package**

Run: `cd apps/api && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/close-api.ts apps/api/src/lib/stellar/intent/serialize.ts apps/api/tests/unit/intent-serialize.test.ts
git commit -m "feat(api): decode setoptions signer type and key instead of a summary"
```

---

## Task 2: Web-side signer identity (local trust-anchor type + independent decoder)

**Files:**

- Modify: `apps/web/types/close-api.ts` (the `set_options` variant of `IntentOperation`)
- Modify: `apps/web/lib/stellar/intent/serialize.ts:1-2,45-53`
- Modify: `apps/web/tests/unit/intent-serialize.test.ts`

**Interfaces:**

- Consumes: `AccountSigner` from `apps/web/types/account.ts` (identical shape to `packages/types`' — local duplicate, per the Global Constraints note).
- Produces: same `set_options.signer: AccountSigner | null` shape as Task 1, but decoded independently by the web's own `intentFromXdr` (this is the function `verify()` actually calls — see Task 3).

- [ ] **Step 1: Extend the local `set_options` type**

In `apps/web/types/close-api.ts`, add the import at the top:

```ts
import type { StepType } from "@/types/plan";
import type { AccountSigner } from "@/types/account";
```

Replace the `set_options` member (currently lines 65-73):

```ts
  | {
      type: "set_options";
      // The signer a SetOptions op touches, decoded to its real type/key (not just weight), so
      // verify() can check it against the account's actual signer set. Null when the op only
      // touches thresholds/master weight and carries no signer field.
      signer: AccountSigner | null;
      masterWeight: number | null;
      lowThreshold: number | null;
      medThreshold: number | null;
      highThreshold: number | null;
    }
```

- [ ] **Step 2: Write the failing decode tests**

Add to the end of `apps/web/tests/unit/intent-serialize.test.ts` (add `StrKey, xdr` to the existing `@stellar/stellar-sdk` import — same edit as Task 1 Step 3):

```ts
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Keypair,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
```

Append the identical five tests from Task 1 Step 3 (same bodies — `signerKey`, `rawHash`, `payloadXdr`/`signedPayloadKey`, and the null-signer case), unchanged, since both `intentFromXdr` implementations must produce byte-identical output for the same input XDR.

- [ ] **Step 3: Run the new tests to confirm they fail**

Run: `cd apps/web && bun test tests/unit/intent-serialize.test.ts`
Expected: FAIL — same reason as Task 1 Step 4, mirrored on the web side.

- [ ] **Step 4: Implement the decode**

In `apps/web/lib/stellar/intent/serialize.ts`, update the imports (lines 1-2):

```ts
import { TransactionBuilder, StrKey, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { AccountSigner } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";
```

Add the same `decodeSigner` helper as Task 1 Step 5 (identical body — the web and api decoders are independent-by-design duplicates, per Global Constraints).

Replace lines 45-53 (`case "setOptions": return { type: "set_options", signerWeight: ..., masterWeight: ..., ... };`):

```ts
    case "setOptions":
      return {
        type: "set_options",
        signer: op.signer ? decodeSigner(op.signer) : null,
        masterWeight: op.masterWeight == null ? null : Number(op.masterWeight),
        lowThreshold: op.lowThreshold == null ? null : Number(op.lowThreshold),
        medThreshold: op.medThreshold == null ? null : Number(op.medThreshold),
        highThreshold: op.highThreshold == null ? null : Number(op.highThreshold),
      };
```

- [ ] **Step 5: Run the tests again to confirm they pass**

Run: `cd apps/web && bun test tests/unit/intent-serialize.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the sibling verify.test.ts fixtures are now broken (expected, fixed in Task 3)**

Run: `cd apps/web && bun test tests/unit/verify.test.ts`
Expected: FAIL — its local `setOptions()` fixture still builds `{ signerWeight: 0, ... }`, which no longer matches `IntentOperation`. This is expected; Task 3 fixes it. Do not fix it here — keep this task's diff scoped to the decoder.

- [ ] **Step 7: Commit**

```bash
git add apps/web/types/close-api.ts apps/web/lib/stellar/intent/serialize.ts apps/web/tests/unit/intent-serialize.test.ts
git commit -m "feat(web): decode setoptions signer type and key instead of a bare weight"
```

---

## Task 3: Extend `verify()`'s trust anchor with the account's real signer set

**Files:**

- Modify: `apps/web/lib/stellar/verify.ts`
- Modify: `apps/web/tests/unit/verify.test.ts`

**Interfaces:**

- Consumes: `IntentOperation`'s new `set_options.signer: AccountSigner | null` (Task 2); `AccountSigner`/`AccountThresholds` from `@/types/account`.
- Produces: `CloseExpectation` gains two new **required** fields (`accountSigners: AccountSigner[]`, `accountThresholds: AccountThresholds`) — Task 4's call site must supply them or the build fails. `verifyCloseTransaction`'s public `opts.expected` gains the same two fields.

- [ ] **Step 1: Update the fixtures and write the failing tests**

In `apps/web/tests/unit/verify.test.ts`:

Add `StrKey` to the existing `@stellar/stellar-sdk` import (already imports `xdr`):

```ts
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
```

Add a new fixture constant near the top (with `SRC`, `DEST`, etc.):

```ts
const REMOVED_SIGNER = Keypair.random().publicKey();
```

Replace the `expectation()` helper to add the two new required fields — the default account has the source's own master key plus one removable secondary signer, matching the default `setOptions()` fixture below so the existing happy-path tests keep passing unchanged:

```ts
function expectation(over: Partial<CloseExpectation> = {}): CloseExpectation {
  return {
    source: SRC,
    destination: DEST,
    mediator: null,
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    accountSigners: [
      { key: SRC, weight: 1, type: "ed25519_public_key" },
      { key: REMOVED_SIGNER, weight: 1, type: "ed25519_public_key" },
    ],
    accountThresholds: { low: 0, med: 1, high: 1 },
    ...over,
  };
}
```

Replace the `setOptions()` helper — it now builds a legitimate single-signer removal by default (matching the account fixture above), instead of a bare weight:

```ts
const setOptions = (
  over: Partial<Extract<IntentOperation, { type: "set_options" }>> = {}
): IntentOperation => ({
  type: "set_options",
  signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 0 },
  masterWeight: null,
  lowThreshold: null,
  medThreshold: null,
  highThreshold: null,
  ...over,
});
```

Update the one existing test that used the old shape — `"rejects a set_options that adds or empowers a signer"` (currently `setOptions({ signerWeight: 1 })`):

```ts
test("rejects a set_options that adds or empowers a signer", () => {
  const i = intent({
    operations: [
      setOptions({ signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 1 } }),
    ],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});
```

Add new tests after it:

```ts
test("rejects a set_options signer removal for a key that is not on the account", () => {
  const i = intent({
    operations: [setOptions({ signer: { type: "ed25519_public_key", key: ATTACKER, weight: 0 } })],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("allows a set_options that only touches thresholds (no signer field)", () => {
  const i = intent({ operations: [setOptions({ signer: null, highThreshold: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("a real close removing all four signer types passes when each is genuinely on the account", () => {
  const hashXRaw = Keypair.random().rawPublicKey();
  const preAuthRaw = Keypair.random().rawPublicKey();
  const signedPayloadXdr = new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("cafebabe", "hex"),
  }).toXDR();
  const signedPayloadKey = StrKey.encodeSignedPayload(signedPayloadXdr);
  const hashXKey = StrKey.encodeSha256Hash(hashXRaw);
  const preAuthKey = StrKey.encodePreAuthTx(preAuthRaw);

  const txXdr = buildXdr([
    Operation.setOptions({ signer: { ed25519PublicKey: REMOVED_SIGNER, weight: 0 } }),
    Operation.setOptions({ signer: { sha256Hash: hashXRaw, weight: 0 } }),
    Operation.setOptions({ signer: { preAuthTx: preAuthRaw, weight: 0 } }),
    Operation.setOptions({ signer: { ed25519SignedPayload: signedPayloadKey, weight: 0 } }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(txXdr, Networks.TESTNET);
  expect(() =>
    assertCloseIntent(
      i,
      expectation({
        accountSigners: [
          { key: SRC, weight: 1, type: "ed25519_public_key" },
          { key: REMOVED_SIGNER, weight: 1, type: "ed25519_public_key" },
          { key: hashXKey, weight: 1, type: "hash_x" },
          { key: preAuthKey, weight: 1, type: "preauth_tx" },
          { key: signedPayloadKey, weight: 1, type: "ed25519_signed_payload" },
        ],
      })
    )
  ).not.toThrow();
});

test("rejects a hash(x) signer removal for a hash that is not a known signer", () => {
  const hashXRaw = Keypair.random().rawPublicKey();
  const txXdr = buildXdr([Operation.setOptions({ signer: { sha256Hash: hashXRaw, weight: 0 } })]);
  const i = intentFromXdr(txXdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});
```

- [ ] **Step 2: Run to confirm failures**

Run: `cd apps/web && bun test tests/unit/verify.test.ts`
Expected: FAIL — `CloseExpectation` doesn't yet have `accountSigners`/`accountThresholds` (type error), and the `set_options` check doesn't yet look at them.

- [ ] **Step 3: Extend `CloseExpectation`**

In `apps/web/lib/stellar/verify.ts`, update the imports (line 1):

```ts
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { lookupExchange } from "@/lib/exchange-registry";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { TxIntent } from "@/types/close-api";
```

Add two fields to the `CloseExpectation` interface, after `claimTrustlineAssets`:

```ts
  /** The account's real signer set at the time it was last read, so a set_options op can be
   *  checked against signers that actually exist on the account, not trusted from the op
   *  alone. Sourced from the account-state read the guided flow already performs, never from
   *  the transaction being verified. */
  accountSigners: AccountSigner[];
  /** The account's real per-category thresholds at the time it was last read. Not consumed by
   *  any check in this module yet - carried through for the signature-accumulation engine
   *  (multisig epic #97, issue #2) that computes how much signing weight a transaction
   *  actually needs. */
  accountThresholds: AccountThresholds;
```

- [ ] **Step 4: Update the `set_options` check**

Replace the `case "set_options":` block in `assertCloseIntent`:

```ts
      case "set_options":
        // Signer normalization may only remove signers, never add/empower one, and the signer
        // it touches must be one that actually exists on the account - otherwise the op has no
        // legitimate purpose in a close and its presence is unexplained. Never disables the
        // master key, and only lowers thresholds (normalization sets them to 0/1/1).
        if (op.signer !== null) {
          if (op.signer.weight !== 0) {
            throw new VerificationError("A signer would be added or empowered.");
          }
          const touchesKnownSigner = expected.accountSigners.some(
            (s) => s.key === op.signer!.key && s.type === op.signer!.type
          );
          if (!touchesKnownSigner) {
            throw new VerificationError(
              "The transaction would modify a signer that is not on this account."
            );
          }
        }
        if (op.masterWeight === 0) {
          throw new VerificationError("The master key would be disabled.");
        }
        if ((op.lowThreshold ?? 0) > 1 || (op.medThreshold ?? 0) > 1 || (op.highThreshold ?? 0) > 1) {
          throw new VerificationError("Account thresholds would be raised.");
        }
        break;
```

- [ ] **Step 5: Extend `verifyCloseTransaction`'s public signature**

Update the `opts.expected` type in `verifyCloseTransaction`:

```ts
export function verifyCloseTransaction(opts: {
  unsignedXdr: string;
  network: Network;
  expected: {
    source: string;
    destination: string;
    mediator: string | null;
    memo: string | null;
    claimTrustlineAssets: string[];
    accountSigners: AccountSigner[];
    accountThresholds: AccountThresholds;
  };
}): void {
```

(The function body already spreads `...opts.expected` into `assertCloseIntent`'s second argument, so no other change is needed here — the spread carries the two new fields through automatically.)

- [ ] **Step 6: Run the tests again to confirm they pass**

Run: `cd apps/web && bun test tests/unit/verify.test.ts`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 7: Type-check and lint**

Run: `cd apps/web && bun run type-check && bun run lint`
Expected: FAIL at this point — `apps/web/hooks/useCloseExecution.ts` calls `verifyCloseTransaction` without the two new required fields. This is expected; Task 4 fixes it. Confirm the _only_ failure is that one call site (read the error output) before moving to Task 4.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/stellar/verify.ts apps/web/tests/unit/verify.test.ts
git commit -m "feat(web): check setoptions signer removals against the account's real signer set"
```

---

## Task 4: Wire the account's real signer set into the execution hook

**Files:**

- Modify: `apps/web/hooks/useCloseExecution.ts`

**Interfaces:**

- Consumes: `verifyCloseTransaction`'s extended `opts.expected` (Task 3); `useDemolishStore`'s existing `accountState: AccountState | null` (`apps/web/store/demolish.ts` — already populated by the analyze/preflight flow, no new read needed).
- Produces: nothing new for later tasks — this closes the loop for issue #98.

- [ ] **Step 1: Read the account's live signer set/thresholds and pass them to `verify()`**

In `apps/web/hooks/useCloseExecution.ts`, inside the `run` callback, add a line near the other "read live so a mid-flow re-decision is honored" reads (after the `claimableBalanceSelections` line, before `decisions`):

```ts
const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
const accountState = useDemolishStore.getState().accountState;
```

Update the `verify` callback passed to `runClose` (currently lines 89-100):

```ts
          verify: (tx: CloseTransaction) =>
            verifyCloseTransaction({
              unsignedXdr: tx.xdr,
              network,
              expected: {
                source: sourceAddress,
                destination: destinationAddress,
                mediator,
                memo,
                claimTrustlineAssets,
                // Empty defaults fail closed: if account state somehow wasn't loaded by
                // execution time, a set_options op touching any signer is rejected rather
                // than trusted.
                accountSigners: accountState?.signers ?? [],
                accountThresholds: accountState?.thresholds ?? { low: 0, med: 1, high: 1 },
              },
            }),
```

- [ ] **Step 2: Type-check and lint the web package**

Run: `cd apps/web && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 3: Run the full web unit suite**

Run: `cd apps/web && bun test tests/unit`
Expected: PASS.

- [ ] **Step 4: Manually confirm the existing single-signer-removal close flow still works**

Run `bun run dev:api` and `bun dev` (per CLAUDE.md's local full-flow setup), point the demolish flow at a funded testnet account, and walk through analyze → review → execute. Confirm `verify()` still accepts the `NORMALIZE_SIGNERS` transaction it did before this change (no new console errors from `verifyCloseTransaction`). This is a manual smoke check, not a new automated test — the existing Playwright E2E suite (testnet-only, per CLAUDE.md) already covers this path structurally and doesn't need a new spec for this issue.

- [ ] **Step 5: Commit**

```bash
git add apps/web/hooks/useCloseExecution.ts
git commit -m "feat(web): pass the account's real signer set into verify()"
```

---

## Task 5: Remove the dead `requiredSignatureCount` stub

**Files:**

- Modify: `apps/web/store/demolish.ts:32-33,119,142`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing — this is a deletion. Confirmed via grep that `requiredSignatureCount` has exactly three references in the entire repo (the interface field, the initial value, and the `setAccountState` computation) and zero consumers anywhere in `apps/web`. Issue #2 of the multisig epic (per `docs/superpowers/specs/2026-08-11-multisig-hardening-design.md`) owns the real per-operation threshold computation and will introduce its own state for it — keeping this stub around would leave a second dead stub, which the issue explicitly calls out to avoid.

- [ ] **Step 1: Remove the field from the state interface**

Delete lines 32-33:

```ts
// Multisig
requiredSignatureCount: number;
```

- [ ] **Step 2: Remove it from `initialState`**

Delete line 119:

```ts
  requiredSignatureCount: 1,
```

- [ ] **Step 3: Remove it from `setAccountState`**

In the `setAccountState` action, remove the `requiredSignatureCount` line so the object becomes:

```ts
  setAccountState: (accountState) =>
    set((s) => ({
      accountState,
      // Keep per-asset decisions across a re-scan of the SAME assets (e.g. the
      // analyze-page refresh button, which re-runs the fetch and lands here):
      // wiping them dropped a user's "return to issuer" choice, after which the
      // fused close silently re-quoted the asset and failed with a lost route.
      // Prune to assets still present so a genuinely-gone trustline can't carry a
      // stale decision into the build.
      assetDispositions: pruneDispositions(s.assetDispositions, accountState),
      claimableBalanceSelections: pruneClaimableSelections(
        s.claimableBalanceSelections,
        accountState
      ),
    })),
```

- [ ] **Step 4: Type-check and run the store's tests (if any)**

Run: `cd apps/web && bun run type-check && bun test tests/unit`
Expected: PASS — no test references `requiredSignatureCount` (confirmed by repo-wide grep before writing this plan), so nothing to update.

- [ ] **Step 5: Commit**

```bash
git add apps/web/store/demolish.ts
git commit -m "refactor(web): remove the dead requiredSignatureCount stub"
```

---

## Task 6: Full verification, repo-wide audit, and PR notes

**Files:** none (verification only).

- [ ] **Step 1: Repo-wide audit for stale `signerWeight` assumptions**

Run: `grep -rn "signerWeight" apps/ packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .claude/worktrees`
Expected: no output. (Confirmed during planning that the only four references were the two type files, `verify.ts`, and the old `verify.test.ts` fixture — all fixed in Tasks 1-3.) If anything unexpected turns up, fix it before proceeding — this is the issue's explicit "audit apps/web for any other place that assumes a SetOptions signer op carries only a weight" task.

- [ ] **Step 2: Confirm CAP-40 (ed25519 signed-payload) has no client-side gap**

No code change expected — this is a confirmation to record in the PR description. `apps/api/src/lib/stellar/tx-builder/signers.ts:25-29` and `apps/api/src/lib/stellar/account.ts:42-47` already build/enumerate ed25519-signed-payload signers correctly. This plan's Task 1/2 decoders now also surface that signer type end-to-end on the client (`StrKey.encodeSignedPayload`, matching the SDK's own decode — verified during planning by reading `@stellar/stellar-sdk`'s `operation.js` decode path), and Task 3's tests exercise it explicitly. State in the PR description: _"Confirmed ed25519 signed-payload (CAP-40) enumeration/removal has no client-side gap — the new decoder in `intent/serialize.ts` surfaces it end to end, exercised by the round-trip test in `verify.test.ts`."_

- [ ] **Step 3: Full monorepo verification**

Run: `bun type-check && bun lint && bun test`
Expected: PASS across `apps/api`, `apps/web`, and `packages/types`.

- [ ] **Step 4: Format check**

Run: `bun run format:check`
Expected: PASS. If it fails, run `bun run format` and re-verify Step 3, then amend the affected task's commit content into a final formatting commit if needed (or fold into the last commit if not yet pushed).

- [ ] **Step 5: Final review pass**

Re-read the diff end to end (`git diff main...HEAD` once on a branch) against the issue's task list and acceptance criteria one more time:

- [ ] `IntentOperation`'s `set_options` variant carries signer type/key (Task 1, 2).
- [ ] `apps/web/lib/stellar/intent/serialize.ts:45-53` no longer collapses to `signerWeight` (Task 2).
- [ ] `CloseExpectation` carries the account's real signer set and thresholds; `set_options` checks reason against it; no regression on the existing single-signer-removal case (Task 3).
- [ ] `requiredSignatureCount` is removed, with the decision (removed, not replaced — issue #2 owns real per-operation computation) noted in the PR description (Task 5).
- [ ] `signerWeight` audit is clean repo-wide (Step 1 of this task).
- [ ] CAP-40 confirmation recorded (Step 2 of this task).
- [ ] Unit tests cover: intent round-trip for all four signer types (Tasks 1, 2); existing single-signer-removal scenarios unchanged (Task 3); `verify()` can access the account's real signer set/thresholds via `CloseExpectation` (Task 3).

No new steps expected here — this task is a checklist re-read, not new code.
