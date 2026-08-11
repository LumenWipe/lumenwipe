# Stellar Wallets Kit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign the close either by connecting a wallet through Stellar Wallets Kit (primary path) or by pasting a secret key (secondary/advanced path, unchanged), while permanently disabling LOBSTR's own browser-extension module (it cannot sign transactions) and reaching LOBSTR only through the kit's WalletConnect module.

**Architecture:** A small `TransactionSigner` interface (`{ publicKey, sign(xdr, networkPassphrase) }`) abstracts "how a transaction gets signed." `SecretKeySigner` wraps the existing `Keypair`-based signing (extracted, not rewritten). `WalletKitSigner` wraps a caller-injected `signTransaction`-shaped function, so it never touches the real kit singleton directly and is fully unit-testable. `ExecutionWizard` gains a two-tab mode switch (wallet primary, secret key secondary) that produces one of these signers; `useCloseExecution.run()` takes a `TransactionSigner` instead of a raw secret key. `close-engine.ts`'s trust-anchor ordering (`verify()` always before `signAndSubmit()`) is untouched — the signer swap happens entirely inside `signAndSubmit`, downstream of verification. A new `apps/web/lib/wallet-kit/modules.ts` is a deliberate whitelist (Freighter, xBull, Albedo, Rabet, Hana + WalletConnect) built via the kit's own `defaultModules({ filterBy })`, not `defaultModules()` minus Lobstr — the kit ships 13 default modules today and the whitelist must not silently grow. A new `apps/web/middleware.ts` adds the strict, nonce-based CSP that `docs/architecture.md` §13.1 already promises but the code never implemented, with the minimum additions the kit's WalletConnect module needs (verified against its actual source, not guessed).

**Tech Stack:** Next.js 15 (App Router), React 19, `@stellar/stellar-sdk` 16.0.1, `@creit-tech/stellar-wallets-kit` 2.5.0 (JSR), Bun 1.3+ / `bun:test`.

## Global Constraints

- Package source: `@creit-tech/stellar-wallets-kit` is JSR-only (scope `creit-tech`, not the old npm `@creit.tech` v1 scope), version 2.5.0. Install via JSR's npm-compatible registry (a repo-root `.npmrc` scoping `@jsr` to `https://npm.jsr.io`, plus an aliased `bun add` from `apps/web` — see Task 1), **not** Bun's native `jsr:` specifier, which fails in this environment. Its own `deno.json` declares `"@stellar/stellar-sdk": "npm:@stellar/stellar-sdk@^16.0.0"`, satisfied by this repo's root `overrides["@stellar/stellar-sdk"] = "16.0.1"`.
- **CLAUDE.md's CJS/ESM stellar-sdk dual-build hazard does not apply here**: every kit module's `signTransaction`/`getAddress` exchanges plain XDR/address **strings**, never `Transaction`/`Keypair` instances — confirmed by reading `freighter.module.ts`, `lobstr.module.ts`, and `wallet-connect.module.ts` upstream. No stellar-sdk object ever crosses the kit boundary, so there is no `instanceof`/class-identity risk to guard against.
- Wallet allowlist is exactly: Freighter (`FREIGHTER_ID = "freighter"`), xBull (`XBULL_ID = "xbull"`), Albedo (`ALBEDO_ID = "albedo"`), Rabet (`RABET_ID = "rabet"`), Hana (`HANA_ID = "hana"`), plus WalletConnect (`WALLET_CONNECT_ID = "wallet_connect"`). **LOBSTR's own module (`LOBSTR_ID = "lobstr"`) is permanently excluded** — it cannot sign. LOBSTR mobile is reachable through WalletConnect instead. Adding any other wallet later (Fordefi, Klever, OneKey, Bitget, CactusLink, Dcent, Scopuly, Ledger, Trezor) is a deliberate future change to the whitelist array, never automatic.
- WalletConnect Cloud Project ID: `ccc0507b2c00ecec3ff2d8aee670e449`. Not a secret (same trust level as an OAuth client ID) — goes in `NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID`, following this repo's existing `NEXT_PUBLIC_MEDIATOR_PUBLIC_*` convention for client-exposed public identifiers.
- UI hierarchy: wallet-connect tab is primary/default; secret-key tab is secondary/advanced — matches `docs/architecture.md` §13's already-published intent, which today is aspirational and must be corrected once this ships.
- Trust anchor is untouched: `apps/web/lib/stellar/verify.ts` and `apps/web/lib/api/close-engine.ts`'s `verify()`-before-`signAndSubmit()` ordering get zero changes in this plan. `verify()` only inspects decoded XDR; it is agnostic to which signer produced the eventual signature.
- Strict TypeScript, no `any` (CONTRIBUTING.md); explicit return types on exported functions.
- Prettier: double quotes, semicolons, printWidth 100 (run `bun run format` if unsure).
- Comments only when the *why* is non-obvious (CLAUDE.md).
- `apps/web/.eslintrc.json`'s `no-restricted-imports` boundary (forbids `@/lib/stellar/tx-builder*`, `@/lib/stellar/step-engine`, `@/lib/stellar/fast-path`, `@/lib/stellar/submit`, `@/lib/stellar/account*`, `@/lib/stellar/horizon-adapter`, `@/lib/stellar/scan-fallback`, `@/lib/stellar/rpc`, `@/lib/stellar/mediator-server`, `@/lib/close-api*`, `@/lib/se-api*`, `@lumenwipe/api*`) is untouched by this plan and must keep passing — none of the new files match these paths, and none of them may ever gain transaction-building or account-closing logic.
- CSP is genuinely new (no `headers()` in `next.config.mjs`, no `middleware.ts` exist today) — this is not "loosening" an existing policy. Every directive addition beyond a strict baseline is justified against the kit's actual upstream source, not added defensively. The one true exception is `style-src 'unsafe-inline'`, required because the kit's modal renders via `twind` (runtime CSS-in-JS) injecting un-nonced `<style>` tags — `script-src` stays strict (nonce + `strict-dynamic`, no `unsafe-eval`, no `unsafe-inline`).
- Bug fixes require a reproducing unit test (CONTRIBUTING.md) — not applicable here (new feature), but every new pure module in this plan ships with a unit test of its own behavior.

---

## File Structure

New files:
- `apps/web/lib/stellar/signer.ts` — `TransactionSigner` interface, `SecretKeySigner`, `WalletKitSigner`.
- `apps/web/lib/wallet-kit/modules.ts` — the vetted wallet whitelist (`vettedDefaultModules`, `walletKitModules`).
- `apps/web/lib/wallet-kit/client.ts` — lazy, browser-only kit init/network-sync (`ensureWalletKitInitialized`).
- `apps/web/components/execution/WalletConnectPanel.tsx` — connect/disconnect UI, mirrors the existing "key loaded / Forget key" pill pattern.
- `apps/web/middleware.ts` — nonce-based CSP.
- `apps/web/tests/unit/signer.test.ts`
- `apps/web/tests/unit/wallet-kit-modules.test.ts`

Modified files:
- `apps/web/package.json` — new dependency.
- `apps/web/.env.example` — documents the new env var (blank).
- `apps/web/.env.local` — real value (gitignored, not committed).
- `apps/web/hooks/useCloseExecution.ts` — `run(secretKey: string)` → `run(signer: TransactionSigner)`.
- `apps/web/components/execution/ExecutionWizard.tsx` — two-tab mode switch, owns a `TransactionSigner` instead of only a raw key.
- `apps/web/app/layout.tsx` — threads the CSP nonce into its two `<script>` tags (becomes an async Server Component).
- `docs/architecture.md` §13 — mark wallet-kit as implemented; document the Lobstr exclusion and the new CSP.

Not modified (reused as-is):
- `apps/web/components/account-entry/SecretKeyInput.tsx`
- `apps/web/lib/stellar/verify.ts`
- `apps/web/lib/api/close-engine.ts`

---

### Task 1: Add the wallet-kit dependency and WalletConnect env var

**Files:**
- Create: `.npmrc` (repo root)
- Modify: `apps/web/package.json`
- Modify: `apps/web/.env.example`
- Modify: `apps/web/.env.local` (gitignored — create the key if the file doesn't already have it)

**Interfaces:**
- Produces: the `@creit-tech/stellar-wallets-kit` package available to import from `apps/web` under its real name (so every `@creit-tech/stellar-wallets-kit/...` import in later tasks resolves), and `process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID` resolvable at build/runtime.

- [ ] **Step 1: Install the package via JSR's npm-compatible registry**

Bun's native `jsr:` specifier (`bun add jsr:@creit-tech/stellar-wallets-kit`) resolves this particular package by shelling out to `git clone`, which fails in this environment (`error: "git clone" for "jsr:@creit-tech/stellar-wallets-kit" failed`) even though plain `git clone`/`curl` to GitHub and to jsr.io both work — a Bun-side quirk with this resolution path, not a network restriction. Use JSR's npm-compatible registry instead, which is a plain HTTPS/tarball install Bun handles the normal way.

Create `.npmrc` at the **repo root** (not `apps/web`) with exactly:
```
@jsr:registry=https://npm.jsr.io
```

Then, from `apps/web`, install the real package under its real name, aliased to the JSR npm-compat package:
```bash
cd apps/web
bun add "@creit-tech/stellar-wallets-kit@npm:@jsr/creit-tech__stellar-wallets-kit@^2.5.0"
cd ..
```

This must resolve to version `2.5.0` and land as `@creit-tech/stellar-wallets-kit` in `apps/web/package.json` — not `@jsr/creit-tech__stellar-wallets-kit` and not an unscoped `stellar-wallets-kit` — so that every subpath import in later tasks (`@creit-tech/stellar-wallets-kit/modules/freighter`, `/types`, `/sdk`, etc.) resolves without any code needing to know about the JSR alias.

- [ ] **Step 2: Verify the version and dependency resolution**

Run: `grep -A1 '"@creit-tech/stellar-wallets-kit"' apps/web/package.json`
Expected: `"@creit-tech/stellar-wallets-kit": "npm:@jsr/creit-tech__stellar-wallets-kit@^2.5.0"` under `dependencies`.

Run: `ls node_modules/@creit-tech/stellar-wallets-kit/package.json`
Expected: the file exists (confirms the package landed under its real scoped name, not just the JSR alias name, and that Bun's hoisting put it at the workspace root `node_modules` alongside every other dependency).

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: PASS — confirms the new dependency's own `@stellar/stellar-sdk@^16.0.0` requirement resolves cleanly against this repo's pinned `16.0.1`, with no lockfile conflict, before any code uses the package.

- [ ] **Step 3: Document the env var in `.env.example`**

Add this block to `apps/web/.env.example`, after the `MEDIATOR_SECRET_TESTNET=` line:

```bash
# Stellar Wallets Kit — WalletConnect module. Public project ID (safe to expose
# to the client), generated at https://cloud.reown.com. Without it, the
# WalletConnect option (used to reach LOBSTR mobile) is unavailable; the other
# wallet-kit options (Freighter, xBull, Albedo, Rabet, Hana) still work.
NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID=
```

- [ ] **Step 4: Set the real value in `.env.local`**

Add to `apps/web/.env.local` (create the file from `.env.example` first if it doesn't exist locally):

```bash
NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID=ccc0507b2c00ecec3ff2d8aee670e449
```

- [ ] **Step 5: Commit**

```bash
git add .npmrc apps/web/package.json bun.lock apps/web/.env.example
git commit -m "chore(web): add stellar-wallets-kit dependency and WalletConnect project id"
```
(The lockfile is `bun.lock` at the repo root — this is a Bun workspaces monorepo, there is no per-package lockfile. `.env.local` is gitignored and is not part of this commit.)

---

### Task 2: `TransactionSigner` interface and `SecretKeySigner`

**Files:**
- Create: `apps/web/lib/stellar/signer.ts`
- Test: `apps/web/tests/unit/signer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TransactionSigner {
    publicKey: string;
    sign(xdr: string, networkPassphrase: string): Promise<string>;
  }
  export class SecretKeySigner implements TransactionSigner { constructor(secretKey: string); }
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/signer.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { SecretKeySigner } from "@/lib/stellar/signer";

function unsignedXdr(sourceKeypair: Keypair): string {
  const builder = new TransactionBuilder(new Account(sourceKeypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  builder.addOperation(Operation.manageData({ name: "close-me", value: null }));
  return builder.build().toXDR();
}

test("SecretKeySigner › publicKey matches the key it was constructed with", () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  expect(signer.publicKey).toBe(kp.publicKey());
});

test("SecretKeySigner › sign() returns a base64 envelope signed by that key", async () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  const xdr = unsignedXdr(kp);

  const signedXdr = await signer.sign(xdr, Networks.TESTNET);

  const signedTx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  expect(signedTx.signatures.length).toBe(1);
  const hint = signedTx.signatures[0].hint();
  expect(hint.equals(kp.signatureHint())).toBe(true);
});

test("SecretKeySigner › sign() does not mutate the original unsigned xdr string", async () => {
  const kp = Keypair.random();
  const signer = new SecretKeySigner(kp.secret());
  const xdr = unsignedXdr(kp);
  const before = xdr;

  await signer.sign(xdr, Networks.TESTNET);

  expect(xdr).toBe(before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test tests/unit/signer.test.ts`
Expected: FAIL — `Cannot find module '@/lib/stellar/signer'` (or similar), since `signer.ts` doesn't exist yet.

- [ ] **Step 3: Implement `TransactionSigner` and `SecretKeySigner`**

Create `apps/web/lib/stellar/signer.ts`:

```ts
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * Abstracts "how a transaction gets signed" so useCloseExecution can drive the
 * close loop the same way regardless of whether the user is signing with a
 * pasted secret key or a connected wallet. Implementations must never persist
 * key material beyond their own lifetime — the caller owns disposal.
 */
export interface TransactionSigner {
  publicKey: string;
  sign(xdr: string, networkPassphrase: string): Promise<string>;
}

/** Signs with an in-memory keypair derived from a pasted secret key. */
export class SecretKeySigner implements TransactionSigner {
  private readonly keypair: Keypair;

  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const built = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    built.sign(this.keypair);
    return built.toEnvelope().toXDR("base64");
  }
}

/**
 * Signs by delegating to a wallet-kit-shaped signing function, injected rather
 * than imported directly — keeps this class free of any DOM/browser-extension
 * dependency and independently testable. Construct with
 * `StellarWalletsKit.signTransaction` in real usage.
 */
export class WalletKitSigner implements TransactionSigner {
  constructor(
    public readonly publicKey: string,
    private readonly signWithKit: (
      xdr: string,
      opts: { networkPassphrase: string; address: string }
    ) => Promise<{ signedTxXdr: string }>
  ) {}

  async sign(xdr: string, networkPassphrase: string): Promise<string> {
    const { signedTxXdr } = await this.signWithKit(xdr, {
      networkPassphrase,
      address: this.publicKey,
    });
    return signedTxXdr;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test tests/unit/signer.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/stellar/signer.ts apps/web/tests/unit/signer.test.ts
git commit -m "feat(web): add TransactionSigner abstraction with secret-key and wallet-kit signers"
```

---

### Task 3: `WalletKitSigner` behavioral test

`WalletKitSigner` was implemented in Task 2 alongside `SecretKeySigner` (same file, same interface, no reason to split the file). This task adds its dedicated test, since it has a different failure mode worth covering explicitly: delegation correctness, not cryptography.

**Files:**
- Modify: `apps/web/tests/unit/signer.test.ts`

**Interfaces:**
- Consumes: `WalletKitSigner` from Task 2 (`apps/web/lib/stellar/signer.ts`).

- [ ] **Step 1: Write the failing test**

Append to `apps/web/tests/unit/signer.test.ts`:

```ts
import { WalletKitSigner } from "@/lib/stellar/signer";

test("WalletKitSigner › delegates to the injected kit signer with the right args and returns its result", async () => {
  const calls: Array<{ xdr: string; opts: { networkPassphrase: string; address: string } }> = [];
  const signer = new WalletKitSigner("GPUBLICKEYEXAMPLE", async (xdr, opts) => {
    calls.push({ xdr, opts });
    return { signedTxXdr: `signed:${xdr}` };
  });

  const result = await signer.sign("raw-xdr", Networks.TESTNET);

  expect(result).toBe("signed:raw-xdr");
  expect(calls).toEqual([
    { xdr: "raw-xdr", opts: { networkPassphrase: Networks.TESTNET, address: "GPUBLICKEYEXAMPLE" } },
  ]);
});

test("WalletKitSigner › publicKey is the address it was constructed with", () => {
  const signer = new WalletKitSigner("GPUBLICKEYEXAMPLE", async () => ({ signedTxXdr: "" }));
  expect(signer.publicKey).toBe("GPUBLICKEYEXAMPLE");
});
```

(`Networks` is already imported at the top of this file from Task 2's Step 1.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test tests/unit/signer.test.ts`
Expected: FAIL if `WalletKitSigner` isn't exported yet; if Task 2 already implemented it correctly, this instead PASSES immediately — in that case skip to Step 4 and just confirm.

- [ ] **Step 3: Fix the implementation if needed**

If Step 2 failed for a reason other than a missing export (e.g. wrong argument order/shape), adjust `WalletKitSigner` in `apps/web/lib/stellar/signer.ts` to match the test's expectations exactly — the test is the spec for the delegation contract used by `WalletConnectPanel` in Task 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test tests/unit/signer.test.ts`
Expected: PASS (all 5 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/unit/signer.test.ts
git commit -m "test(web): cover WalletKitSigner's delegation contract"
```

---

### Task 4: Vetted wallet-kit module allowlist

**Files:**
- Create: `apps/web/lib/wallet-kit/modules.ts`
- Test: `apps/web/tests/unit/wallet-kit-modules.test.ts`

**Interfaces:**
- Consumes: `@creit-tech/stellar-wallets-kit/modules/utils` (`defaultModules`), `.../modules/{freighter,xbull,albedo,rabet,hana,lobstr,wallet-connect}` (ID constants + `WalletConnectModule`), `@creit-tech/stellar-wallets-kit/types` (`ModuleInterface`).
- Produces:
  ```ts
  export const ALLOWED_DEFAULT_MODULE_IDS: readonly string[];
  export function vettedDefaultModules(): ModuleInterface[]; // DOM-free, no network — Freighter/xBull/Albedo/Rabet/Hana only
  export function walletKitModules(): ModuleInterface[]; // vettedDefaultModules() + WalletConnectModule; throws if the project id env var is missing
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/wallet-kit-modules.test.ts`:

```ts
import { test, expect } from "bun:test";
import { LOBSTR_ID } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { ALLOWED_DEFAULT_MODULE_IDS, vettedDefaultModules } from "@/lib/wallet-kit/modules";

test("vettedDefaultModules › never includes LOBSTR's own module", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).not.toContain(LOBSTR_ID);
});

test("vettedDefaultModules › includes exactly the vetted whitelist, nothing else", () => {
  const ids = vettedDefaultModules()
    .map((m) => m.productId)
    .sort();
  expect(ids).toEqual([...ALLOWED_DEFAULT_MODULE_IDS].sort());
});

test("vettedDefaultModules › includes Freighter", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).toContain(FREIGHTER_ID);
});
```

Note: `walletKitModules()` (which also constructs `WalletConnectModule`) is deliberately **not** unit-tested here. `WalletConnectModule`'s constructor calls `SignClient.init(...)` and `createAppKit(...)` from `@reown/appkit/core`, which expect a real browser DOM — exercising it under `bun:test` would mean mocking the DOM just to prove a list-membership fact `vettedDefaultModules()` already proves without that fragility. Its wiring is covered by manual QA in Task 6.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test tests/unit/wallet-kit-modules.test.ts`
Expected: FAIL — `Cannot find module '@/lib/wallet-kit/modules'`.

- [ ] **Step 3: Implement the module allowlist**

Create `apps/web/lib/wallet-kit/modules.ts`:

```ts
import { defaultModules } from "@creit-tech/stellar-wallets-kit/modules/utils";
import { WalletConnectModule } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";

/**
 * LOBSTR's own browser-extension module is intentionally excluded: it cannot
 * sign transactions. LOBSTR mobile is reachable through the WalletConnect
 * module instead. This is a deliberate whitelist, not `defaultModules()` minus
 * Lobstr — the kit ships 13 default modules today (most unreviewed by us);
 * add a new one here only after vetting it, never automatically.
 */
export const ALLOWED_DEFAULT_MODULE_IDS: readonly string[] = [
  FREIGHTER_ID,
  XBULL_ID,
  ALBEDO_ID,
  RABET_ID,
  HANA_ID,
];

export function vettedDefaultModules(): ModuleInterface[] {
  return defaultModules({ filterBy: (m) => ALLOWED_DEFAULT_MODULE_IDS.includes(m.productId) });
}

/** Full module list for `StellarWalletsKit.init`, including WalletConnect. */
export function walletKitModules(): ModuleInterface[] {
  const projectId = process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error("Missing NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID.");
  }

  return [
    ...vettedDefaultModules(),
    new WalletConnectModule({
      projectId,
      metadata: {
        name: "LumenWipe",
        description: "Close your Stellar account safely and recover your XLM.",
        url: process.env.NEXT_PUBLIC_APP_URL || "https://lumenwipe.com",
        icons: ["https://lumenwipe.com/favicon-96x96.png"],
      },
    }),
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test tests/unit/wallet-kit-modules.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/wallet-kit/modules.ts apps/web/tests/unit/wallet-kit-modules.test.ts
git commit -m "feat(web): whitelist Freighter, xBull, Albedo, Rabet, Hana and WalletConnect; exclude LOBSTR's own module"
```

---

### Task 5: Wallet-kit client singleton

**Files:**
- Create: `apps/web/lib/wallet-kit/client.ts`

**Interfaces:**
- Consumes: `walletKitModules()` from Task 4; `Network` type from `apps/web/config/networks.ts`.
- Produces:
  ```ts
  export function ensureWalletKitInitialized(network: Network): typeof StellarWalletsKit;
  ```
  Later tasks call this only from `useEffect`/event handlers (never at module top-level or during render), so it never runs during SSR.

- [ ] **Step 1: Implement the singleton**

Create `apps/web/lib/wallet-kit/client.ts`:

```ts
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { Networks } from "@creit-tech/stellar-wallets-kit/types";
import type { Network } from "@/config/networks";
import { walletKitModules } from "./modules";

const KIT_NETWORKS: Record<Network, Networks> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

let initialized = false;

/**
 * Initializes the kit's static singleton on first use and keeps its network in
 * sync afterward. Must only be called client-side (inside useEffect or an
 * event handler) — `StellarWalletsKit.init` touches the DOM and preact
 * signals, which do not exist during Next.js's server render pass.
 */
export function ensureWalletKitInitialized(network: Network): typeof StellarWalletsKit {
  if (typeof window === "undefined") {
    throw new Error("The wallet kit can only be used in the browser.");
  }

  if (!initialized) {
    StellarWalletsKit.init({ modules: walletKitModules(), network: KIT_NETWORKS[network] });
    initialized = true;
  } else {
    StellarWalletsKit.setNetwork(KIT_NETWORKS[network]);
  }

  return StellarWalletsKit;
}
```

No unit test for this file: every branch either touches `window`/the DOM (guarded by the `typeof window` check, so it's a one-line trivial branch) or delegates straight to the real kit's static methods, which Task 4's note already explains is impractical to exercise outside a browser. It is covered by manual QA in Task 6.

- [ ] **Step 2: Confirm it type-checks**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/wallet-kit/client.ts
git commit -m "feat(web): add lazy, browser-only stellar-wallets-kit singleton"
```

---

### Task 6: `WalletConnectPanel` component

**Files:**
- Create: `apps/web/components/execution/WalletConnectPanel.tsx`

**Interfaces:**
- Consumes: `ensureWalletKitInitialized` (Task 5); `KitEventType` from `@creit-tech/stellar-wallets-kit/types`; `Network` from `apps/web/config/networks.ts`.
- Produces:
  ```tsx
  interface WalletConnectPanelProps {
    network: Network;
    onConnected: (publicKey: string) => void;
    onDisconnected: () => void;
    disabled?: boolean;
  }
  export default function WalletConnectPanel(props: WalletConnectPanelProps): JSX.Element;
  ```
  `ExecutionWizard` (Task 8) renders this and reacts to `onConnected`/`onDisconnected` to build/clear a `WalletKitSigner`.

- [ ] **Step 1: Implement the component**

Create `apps/web/components/execution/WalletConnectPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle } from "lucide-react";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import type { Network } from "@/config/networks";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

interface Props {
  network: Network;
  onConnected: (publicKey: string) => void;
  onDisconnected: () => void;
  disabled?: boolean;
}

export default function WalletConnectPanel({ network, onConnected, onDisconnected, disabled }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const kit = ensureWalletKitInitialized(network);
    return kit.on(KitEventType.DISCONNECT, () => {
      setAddress(null);
      onDisconnected();
    });
  }, [network, onDisconnected]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const kit = ensureWalletKitInitialized(network);
      const { address: connected } = await kit.authModal();
      setAddress(connected);
      onConnected(connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the wallet.");
    } finally {
      setConnecting(false);
    }
  }, [network, onConnected]);

  const disconnect = useCallback(async () => {
    await ensureWalletKitInitialized(network).disconnect();
    setAddress(null);
    onDisconnected();
  }, [network, onDisconnected]);

  if (address) {
    return (
      <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Connected: {address.slice(0, 4)}…{address.slice(-4)}
        </span>
        <button
          type="button"
          onClick={disconnect}
          className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={connect}
        disabled={disabled || connecting}
        className="w-full py-2.5 px-4 rounded-lg font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Confirm it type-checks and lints**

Run: `bun run --filter '@lumenwipe/web' type-check && bun run --filter '@lumenwipe/web' lint`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/execution/WalletConnectPanel.tsx
git commit -m "feat(web): add WalletConnectPanel for connecting a wallet via the kit"
```

---

### Task 7: Wire `useCloseExecution` to `TransactionSigner`

**Files:**
- Modify: `apps/web/hooks/useCloseExecution.ts`

**Interfaces:**
- Consumes: `TransactionSigner` from Task 2.
- Produces: `run(signer: TransactionSigner): Promise<void>` (was `run(secretKey: string)`).

- [ ] **Step 1: Confirm the existing close-engine tests still pass before touching anything**

Run: `cd apps/web && bun test tests/unit/close-engine.test.ts`
Expected: PASS (this file is untouched by this task — establishes the baseline `runClose`'s verify-before-sign guarantee is intact).

- [ ] **Step 2: Rewrite `useCloseExecution.ts`**

Replace the full contents of `apps/web/hooks/useCloseExecution.ts` with:

```ts
"use client";

import { useCallback, useState } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { runClose } from "@/lib/api/close-engine";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import { claimableSelectionsToDecisions, dispositionsToDecisions } from "@/lib/api/close-decisions";
import { verifyCloseTransaction } from "@/lib/stellar/verify";
import { submitViaApi } from "@/lib/stellar/submit-via-api";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { notifyStatsRefresh } from "@/lib/stats-events";
import type { TransactionSigner } from "@/lib/stellar/signer";

/**
 * Drives a full close against the API: the browser fetches unsigned transactions round by
 * round, VERIFIES each one against the user's own choices before signing (the trust anchor),
 * signs via the given signer (co-signing the mediator forward payment when needed), submits
 * through the proxy, and marks the plan steps each transaction covers as confirmed. The
 * account state is re-read server-side every round, so an interrupted close resumes by
 * simply running again.
 */
export function useCloseExecution() {
  const network = useNetworkStore((s) => s.network);
  const sourceAddress = useDemolishStore((s) => s.sourceAddress);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const memo = useDemolishStore((s) => s.memo);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const mediatorPublicKey = useDemolishStore((s) => s.mediatorPublicKey);
  const markCoveredConfirmed = useDemolishStore((s) => s.markCoveredConfirmed);
  const setPhase = useDemolishStore((s) => s.setPhase);
  const setLastError = useDemolishStore((s) => s.setLastError);

  const [progressStatus, setProgressStatus] = useState<string | null>(null);

  const run = useCallback(
    async (signer: TransactionSigner): Promise<void> => {
      if (!sourceAddress || !destinationAddress) {
        setLastError("Missing account or destination.");
        setPhase("STEP_FAILED");
        return;
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      const mediator = mediatorRequired ? mediatorPublicKey : null;
      // Read dispositions/selections live so a mid-flow re-decision is honored.
      const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
      const decisions = [
        ...dispositionsToDecisions(useDemolishStore.getState().assetDispositions),
        ...claimableSelectionsToDecisions(claimableBalanceSelections),
      ];
      // The set of assets the user themselves chose to add a trustline for, to claim an
      // otherwise-unreachable balance - verify()'s only basis for allowing a raised (non-
      // removal) change_trust op. Sourced from the user's own decisions, never the API.
      const claimTrustlineAssets = Object.entries(claimableBalanceSelections)
        .filter(([, selection]) => selection === "add_trustline_then_claim")
        .map(([balanceId]) => {
          const balance = useDemolishStore
            .getState()
            .accountState?.claimableBalances.find((b) => b.id === balanceId);
          return balance?.asset ?? null;
        })
        .filter((asset): asset is string => asset !== null);

      setPhase("STEP_EXECUTING");
      try {
        await runClose({
          getTransactions: () =>
            fetchCloseTransactions(
              {
                source: sourceAddress,
                destination: destinationAddress,
                decisions,
                memo: memo ?? undefined,
              },
              network
            ),
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
              },
            }),
          signAndSubmit: async (tx: CloseTransaction) => {
            setProgressStatus("Signing transaction…");
            // Computed from the exact XDR verify() approved, before any signer touches it —
            // the anchor for both checks below. The hash covers only the transaction body
            // (source, ops, sequence, memo, fee), never signatures, so it stays valid
            // whether taken before or after signing.
            const approvedHash = TransactionBuilder.fromXDR(tx.xdr, passphrase)
              .hash()
              .toString("hex");
            let signedXdr = await signer.sign(tx.xdr, passphrase);

            // A connected wallet (WalletKitSigner) is a black box outside this app's trust
            // boundary — unlike SecretKeySigner, which signs by parsing this exact xdr and
            // re-serializing it (so its output can never diverge in body), an external signer
            // could in principle return a signature over a different transaction. Assert it
            // didn't before trusting the result any further.
            const signedHash = TransactionBuilder.fromXDR(signedXdr, passphrase)
              .hash()
              .toString("hex");
            if (signedHash !== approvedHash) {
              throw new Error("The signed transaction does not match what you approved.");
            }

            // A merge through the shared mediator is one atomic transaction: the user
            // signed the merge; the backend co-signs the mediator's forward payment. It
            // cannot change destination or amount, so funds can never be diverted.
            if (mediator && tx.covers.includes("MERGE")) {
              setProgressStatus("Co-signing the forward payment…");
              // Defense-in-depth: the mediator may ONLY add its signature — assert it did not
              // alter the body before submit.
              const cosignedXdr = await requestMediatorCosignature(signedXdr, network);
              const cosigned = TransactionBuilder.fromXDR(cosignedXdr, passphrase);
              if (cosigned.hash().toString("hex") !== approvedHash) {
                throw new Error("The co-signed transaction does not match what you approved.");
              }
              signedXdr = cosignedXdr;
            }

            setProgressStatus("Submitting to Stellar network…");
            const { txHash } = await submitViaApi(signedXdr, network);
            return txHash;
          },
          onConfirmed: (tx, hash) => {
            markCoveredConfirmed(tx.covers, hash);
            if (tx.covers.includes("MERGE") || tx.covers.includes("CLOSE_ACCOUNT")) {
              recordMergeStats(hash, network);
            }
          },
          onProgress: setProgressStatus,
        });
        setPhase("COMPLETE");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : "The close failed.";
        setLastError(message);
        setPhase("STEP_FAILED");
      } finally {
        setProgressStatus(null);
      }
    },
    [
      network,
      sourceAddress,
      destinationAddress,
      memo,
      mediatorRequired,
      mediatorPublicKey,
      markCoveredConfirmed,
      setPhase,
      setLastError,
    ]
  );

  return { run, progressStatus };
}

/**
 * Records a confirmed merge for the live stats counter without blocking execution.
 * Failures are logged, not surfaced — the close already succeeded.
 */
function recordMergeStats(txHash: string, network: string): void {
  fetch("/api/stats/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash, network }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`stats record returned ${res.status}`);
      notifyStatsRefresh();
    })
    .catch((err) => {
      console.error(`Failed to record merge stats for tx ${txHash}:`, err);
    });
}
```

The substantive changes from the previous version: the `Keypair` import and `import { Keypair, TransactionBuilder }` line becomes `import { TransactionBuilder }` only; `run`'s parameter changes from `secretKey: string` to `signer: TransactionSigner`; the `const keypair = Keypair.fromSecret(secretKey);` line is removed; `built.sign(keypair)` + `built.toEnvelope().toXDR("base64")` becomes `await signer.sign(tx.xdr, passphrase)`; `approvedHash` is now computed once, up front, from `tx.xdr` (the exact XDR `verify()` approved) rather than from the post-signature `built`/`signedXdr` object — this is the anchor for a **new** post-sign integrity check (added after this task was first reviewed): once `signer.sign()` returns, the code re-parses `signedXdr` and asserts its hash equals `approvedHash` before doing anything else with it, and throws `"The signed transaction does not match what you approved."` if not.

This new check exists because `SecretKeySigner` and `WalletKitSigner` are not equally trustworthy by construction: `SecretKeySigner.sign()` parses the exact given `xdr`, appends a signature, and re-serializes — its output can never diverge in transaction body from its input. `WalletKitSigner.sign()`, by contrast, delegates to an external, black-box wallet and returns whatever XDR it hands back, with no in-process guarantee it corresponds to the same transaction body it was asked to sign. Trusting a wallet to sign exactly what it's given is the standard model for any wallet integration (SEP-43 requires it, and the wallet's own UI is the user's last line of defense) — but this app's `verify()` architecture already goes beyond that industry baseline, and the mediator co-sign check already defends the exact same class of concern for a different actor (the mediator). Adding the equivalent check for the signer itself closes the one gap where a compromised or buggy external signer could submit a transaction never actually seen by the trust anchor: no other task in this plan touches this behavior, and the mediator check below is otherwise unaffected — `approvedHash` continues to mean "the hash of the transaction body `verify()` approved," it's simply computed earlier now, before `signer.sign()` is even called instead of after.

- [ ] **Step 3: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: **FAILS** with exactly one type error, in `ExecutionWizard.tsx` (`run(secretKeyRef.current)` passing a `string` where `run` now expects a `TransactionSigner`). This is expected at this point in the plan — Task 8 fixes that call site — and confirms the only fallout from this task's change is that one call site, not a mistake inside `useCloseExecution.ts` itself. If any other file reports an error, stop and investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/hooks/useCloseExecution.ts
git commit -m "refactor(web): make useCloseExecution sign via TransactionSigner instead of a raw secret key"
```

(This commit is expected to leave `ExecutionWizard.tsx`'s call site broken until Task 8 lands — both are part of the same logical change and should be reviewed together; committing them separately keeps each diff reviewable on its own terms per this repo's task-by-task workflow.)

---

### Task 8: Wire `ExecutionWizard` to the two-tab signer UI

**Files:**
- Modify: `apps/web/components/execution/ExecutionWizard.tsx`

**Interfaces:**
- Consumes: `TransactionSigner`, `SecretKeySigner`, `WalletKitSigner` (Task 2); `WalletConnectPanel` (Task 6); `ensureWalletKitInitialized` (Task 5, indirectly via `WalletConnectPanel`); `run(signer: TransactionSigner)` (Task 7).

- [ ] **Step 1: Replace the full contents of `ExecutionWizard.tsx`**

```tsx
"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { cn } from "@/lib/utils/cn";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel from "./WalletConnectPanel";
import PlanSidebar from "./PlanSidebar";
import ProgressIndicator from "./ProgressIndicator";
import { SecretKeySigner, WalletKitSigner, type TransactionSigner } from "@/lib/stellar/signer";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

interface ExecutionWizardProps {
  network: Network;
}

type SignMode = "wallet" | "secret-key";

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");
  const signerRef = useRef<TransactionSigner | null>(null);

  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const phase = useDemolishStore((s) => s.phase);
  const lastError = useDemolishStore((s) => s.lastError);

  const { run, progressStatus } = useCloseExecution();
  const [mode, setMode] = useState<SignMode>("wallet");
  const [keyEntered, setKeyEntered] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);

  const signerReady = mode === "wallet" ? walletAddress !== null : keyEntered;

  const clearSigner = useCallback(() => {
    secretKeyRef.current = "";
    signerRef.current = null;
    setKeyEntered(false);
    setWalletAddress(null);
  }, []);

  // Wipe signing material when the wizard unmounts (navigation away).
  useEffect(() => () => clearSigner(), [clearSigner]);

  // On success, wipe signing material and advance to the completion screen.
  useEffect(() => {
    if (phase === "COMPLETE") {
      clearSigner();
      router.push(`/${network}/complete`);
    }
  }, [phase, network, router, clearSigner]);

  const forgetKey = useCallback(() => {
    secretKeyRef.current = "";
    signerRef.current = null;
    setKeyEntered(false);
  }, []);

  const onSecretKeyValidityChange = useCallback(
    (valid: boolean) => {
      setKeyEntered(valid);
      if (valid) {
        signerRef.current = new SecretKeySigner(secretKeyRef.current);
        // Entering a working secret key supersedes any previously connected wallet —
        // exactly one signer is ever live, so the two tabs can never disagree about
        // which one `execute()` will actually use.
        setWalletAddress(null);
      } else if (!walletAddress) {
        // Only clear the shared signer if a wallet isn't the one currently holding
        // it — otherwise typing an incomplete key while a wallet is connected would
        // silently discard the wallet's signer without any visible feedback.
        signerRef.current = null;
      }
    },
    [walletAddress]
  );

  const onWalletConnected = useCallback(
    (publicKey: string) => {
      signerRef.current = new WalletKitSigner(publicKey, (xdr, opts) =>
        ensureWalletKitInitialized(network).signTransaction(xdr, opts)
      );
      setWalletAddress(publicKey);
      // Connecting a wallet supersedes any previously entered secret key, for the
      // same reason: the secret-key tab must not keep showing "loaded" once a
      // different signer is what `execute()` will actually use.
      secretKeyRef.current = "";
      setKeyEntered(false);
    },
    [network]
  );

  const onWalletDisconnected = useCallback(() => {
    signerRef.current = null;
    setWalletAddress(null);
  }, []);

  const execute = useCallback(async () => {
    if (!signerRef.current || running) return;
    setRunning(true);
    try {
      // The engine re-reads on-chain state each round, so a retry after a failure
      // resumes: already-confirmed steps are not rebuilt or re-submitted.
      await run(signerRef.current);
    } finally {
      setRunning(false);
    }
  }, [run, running]);

  if (executionPlan.length === 0 || !destinationAddress) {
    return (
      <div className="text-center py-12 text-white/45 text-sm">
        No execution plan found. Please go back and analyze your account.
      </div>
    );
  }

  const failed = phase === "STEP_FAILED" && !running;
  const busy = running || progressStatus !== null;

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-52 shrink-0 hidden md:block">
        <div className="sticky top-20">
          <p className="mkt-eyebrow text-white/45 mb-3">Steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign &amp; execute the close</h2>
            <p className="mt-1 text-sm text-white/55">
              LumenWipe signs each transaction in your browser and submits it through the API. Your
              key never leaves this device.
            </p>
          </div>

          {/* Trust note */}
          <div className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-white/60">
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-stellar" />
            <span>
              Every transaction is verified against your own choices — destination, asset
              decisions, and memo — before it is signed. Anything unexpected is rejected.
            </span>
          </div>

          {/* Irreversible warning */}
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm">
            <p className="font-semibold text-destructive mb-1">
              This action is permanent and irreversible.
            </p>
            <p className="text-white/60">
              The account will be removed from the Stellar ledger and its balance sent to{" "}
              <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
              {mediatorRequired ? " through the exchange mediator." : "."} Verify it carefully.
            </p>
          </div>

          {busy ? (
            <ProgressIndicator status={progressStatus ?? "Working…"} />
          ) : failed ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-white/70">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
                <span>{lastError ?? "The close could not be completed."}</span>
              </div>
              <button
                onClick={execute}
                disabled={!signerReady}
                className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2 rounded-lg bg-white/[0.03] p-1">
                <button
                  type="button"
                  onClick={() => setMode("wallet")}
                  className={cn(
                    "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
                    mode === "wallet" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
                  )}
                >
                  Connect wallet
                </button>
                <button
                  type="button"
                  onClick={() => setMode("secret-key")}
                  className={cn(
                    "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
                    mode === "secret-key"
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:text-white/80"
                  )}
                >
                  Use secret key (advanced)
                </button>
              </div>

              {mode === "wallet" ? (
                <WalletConnectPanel
                  network={network}
                  onConnected={onWalletConnected}
                  onDisconnected={onWalletDisconnected}
                  disabled={running}
                />
              ) : keyEntered ? (
                <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                  <span className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle className="h-4 w-4 shrink-0" />
                    Secret key loaded for this session
                  </span>
                  <button
                    type="button"
                    onClick={forgetKey}
                    className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
                  >
                    Forget key
                  </button>
                </div>
              ) : (
                <SecretKeyInput
                  secretKeyRef={secretKeyRef}
                  onValidityChange={onSecretKeyValidityChange}
                  disabled={running}
                />
              )}

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 accent-stellar"
                />
                <span className="text-sm text-white/60">
                  I understand this permanently closes the account and sends its balance to the
                  destination above.
                </span>
              </label>

              <button
                onClick={execute}
                disabled={!signerReady || !confirmed}
                className={cn(
                  "w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all",
                  "flex items-center justify-center gap-2",
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                  "disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                Sign &amp; execute close
              </button>
            </>
          )}
        </div>

        {/* Mobile step list */}
        <div className="md:hidden mt-5">
          <p className="mkt-eyebrow text-white/45 mb-2">All steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check and lint the whole web package**

Run: `bun run --filter '@lumenwipe/web' type-check && bun run --filter '@lumenwipe/web' lint`
Expected: both PASS — this also confirms Task 7's `useCloseExecution.ts` now compiles cleanly against this call site.

- [ ] **Step 3: Run the full web unit test suite**

Run: `cd apps/web && bun test tests/unit`
Expected: PASS — confirms `close-engine.test.ts`, `verify.test.ts`, `signer.test.ts`, and `wallet-kit-modules.test.ts` all still pass together.

- [ ] **Step 4: Manual smoke test**

Run `bun run dev:api` and `bun dev` (per CLAUDE.md's local full-flow dev setup), open a testnet close through to the `/execute` step, and confirm:
- The "Connect wallet" tab is selected by default and lists Freighter, xBull, Albedo, Rabet, Hana, and WalletConnect — never LOBSTR as its own entry.
- Connecting a testnet-funded Freighter account enables "Sign & execute close" once the confirmation checkbox is also checked.
- Switching to "Use secret key (advanced)" and pasting a valid testnet secret key works exactly as before.
- Disconnecting the wallet (or clicking "Forget key") disables the execute button again.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/execution/ExecutionWizard.tsx
git commit -m "feat(web): add wallet-connect as the primary signing path in ExecutionWizard"
```

---

### Task 9: Strict CSP via nonce-based middleware

**Files:**
- Create: `apps/web/middleware.ts`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**
- Produces: a `Content-Security-Policy` response header on every non-static, non-API route, with a per-request nonce available to Server Components via the `x-nonce` request header.

- [ ] **Step 1: Create the middleware**

Create `apps/web/middleware.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

// The kit's WalletConnect module (@reown/appkit/core + @walletconnect/sign-client)
// talks to these hosts directly — verified against its source, not guessed:
// the session relay, Reown's wallet explorer/analytics, and its "Verify API"
// iframe that shows a connecting wallet this dApp is legitimate.
const WALLET_CONNECT_RELAY_HOSTS = "wss://relay.walletconnect.org wss://relay.walletconnect.com";
const WALLET_CONNECT_AUX_HOSTS =
  "https://pulse.walletconnect.org https://api.web3modal.org https://explorer-api.walletconnect.com";
const WALLET_CONNECT_VERIFY_HOSTS = "https://verify.walletconnect.com https://verify.walletconnect.org";

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // The wallet kit's connect modal renders via twind (runtime CSS-in-JS),
    // which injects <style> tags with no nonce support — the one deliberate
    // exception here. script-src stays strict (no unsafe-inline, no unsafe-eval).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self' ${WALLET_CONNECT_RELAY_HOSTS} ${WALLET_CONNECT_AUX_HOSTS}`,
    `frame-src ${WALLET_CONNECT_VERIFY_HOSTS}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets, image optimization, and the JSON API routes (which
    // carry no HTML/inline scripts and don't need a nonce or CSP header).
    "/((?!_next/static|_next/image|favicon|api/).*)",
  ],
};
```

- [ ] **Step 2: Thread the nonce into `layout.tsx`'s inline/external scripts**

In `apps/web/app/layout.tsx`, add the import and make the component read the nonce:

```tsx
import { headers } from "next/headers";
```

Change:
```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
```
to:
```tsx
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
```

And add `nonce={nonce}` to both existing `<script>` tags:

```tsx
<script
  type="application/ld+json"
  nonce={nonce}
  dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
/>
{process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
  <script
    defer
    nonce={nonce}
    src="https://cloud.umami.is/script.js"
    data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
  />
)}
```

(These two scripts are the only ones in `layout.tsx` today; without the nonce, the JSON-LD structured-data script and the optional Umami analytics script would silently stop executing once `script-src` goes strict, breaking SEO structured data and analytics — this is why `layout.tsx` is in scope for a task that is nominally "add CSP for the wallet kit.")

- [ ] **Step 3: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: PASS.

- [ ] **Step 4: Verify the header locally**

Run `bun dev` (or `bun run --filter '@lumenwipe/web' dev`), then in another terminal:
```bash
curl -sI http://localhost:3000/testnet | grep -i "content-security-policy"
```
Expected: a `content-security-policy:` header containing `script-src 'self' 'nonce-` and the `connect-src`/`frame-src` WalletConnect hosts listed above.

Then load the site in a browser, open DevTools → Console, and confirm there are no CSP violation errors for the structured-data script, the Umami script (if `NEXT_PUBLIC_UMAMI_WEBSITE_ID` is set locally), or the wallet-kit modal opened from Task 8's manual smoke test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/middleware.ts apps/web/app/layout.tsx
git commit -m "feat(web): add strict nonce-based CSP scoped to the wallet kit's requirements"
```

---

### Task 10: Update `docs/architecture.md` §13

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Read the current §13 wording**

Run: `grep -n "stellar-wallets-kit\|LOBSTR\|Content Security Policy" docs/architecture.md`

- [ ] **Step 2: Update the text**

At each location the grep in Step 1 surfaces:
- Change wording that describes the wallet-kit path as a future/aspirational primary path to describe it as implemented (primary tab in `ExecutionWizard`), listing the exact vetted wallets: Freighter, xBull, Albedo, Rabet, Hana, and WalletConnect.
- Add a sentence noting LOBSTR's own module is disabled because it cannot sign, and that LOBSTR is reached through WalletConnect instead.
- Change the CSP line from "intended" to implemented, and name the one intentional exception (`style-src 'unsafe-inline'`, required by the kit's runtime style injection).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: document the implemented wallet-kit signing path and CSP"
```

---

## Self-Review Notes

- **Spec coverage:** every approved design section has a task — signer abstraction (2, 3), module whitelist (4), kit singleton (5), UI (6, 8), engine wiring (7), CSP (9), docs (10), dependency/env setup (1).
- **Placeholder scan:** no TBD/TODO; every code step is complete, runnable code; no "similar to Task N" shorthand — Task 8's full file is written out in full even though most of it is unchanged from today, since an implementer reading tasks out of order needs the whole file.
- **Type consistency:** `TransactionSigner`/`SecretKeySigner`/`WalletKitSigner` (Task 2) are used with identical signatures in Tasks 3, 7, and 8. `walletKitModules`/`vettedDefaultModules`/`ALLOWED_DEFAULT_MODULE_IDS` (Task 4) are used identically in Task 5 and their own test. `ensureWalletKitInitialized` (Task 5) is used identically in Task 6 and Task 8.
