# Wallet-Connect Account Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user connect their Stellar Wallets Kit wallet on the account-entry screen (`/[network]`) to supply the account-to-close address, instead of only pasting it — and have that same connection carry through to the sign step (`/[network]/execute`) without reconnecting, since the kit's own singleton already persists the session across client-side navigation.

**Architecture:** A new hook, `useWalletKitConnection(network)`, is the single owner of wallet-connection lifecycle (connect, disconnect, mount-time detection of an already-connected session, and a network-mismatch check against the app's active network). `WalletConnectPanel` becomes a purely presentational component driven by that hook's return value, used by both `AccountEntryForm` (new "Connect wallet" tab, address becomes a non-editable pill once connected) and `ExecutionWizard` (already had this pattern; now consumes the shared hook instead of owning its own connect/disconnect/DISCONNECT-subscription logic). `ExecutionWizard` reactively syncs its `TransactionSigner` whenever the hook's connected address changes — including on mount, if a wallet was already connected during account entry — but only auto-selects it as the active signer when the connected address matches `sourceAddress` and the wallet's network matches the app's; a mismatch on either axis surfaces as a clear, non-blocking notice instead of silently doing nothing or silently proceeding.

**Tech Stack:** Next.js 15 (App Router), React 19, `@creit-tech/stellar-wallets-kit` 2.5.0 (already installed), Bun 1.3+.

## Global Constraints

- The wallet-connect tab is primary/default on both `AccountEntryForm` and `ExecutionWizard`, matching the precedent already set by the merged wallet-kit integration (docs/superpowers/plans/2026-08-10-stellar-wallets-kit-integration.md).
- Once connected via wallet on `AccountEntryForm`, the address is a **fixed, non-editable pill** (matching `WalletConnectPanel`'s existing "Connected: G...XXXX / Disconnect" pattern) — never a pre-filled editable text field. This prevents a user from connecting a wallet and then silently editing the address to something the wallet didn't actually supply.
- The wallet session must **persist across the flow** without any new cross-route state: `StellarWalletsKit` is already a static singleton that persists `activeAddress`/`selectedModuleId` to `localStorage` (confirmed from the installed package's source), so "stays connected" is achieved by having `ExecutionWizard` *detect* an existing session on mount (`kit.getAddress()`), not by threading new state through the Zustand store.
- If the wallet connected at `/execute` doesn't match `sourceAddress` (the account the user is closing, set during account entry), OR the wallet's active network doesn't match the app's selected network: show a clear, specific notice (not a silent no-op, not a silent auto-proceed) and do not auto-select that wallet as the active signer. The existing `useCloseExecution.ts` safety check (`signer.publicKey !== sourceAddress`, from the merged wallet-kit-integration PR) remains as the last-resort guard regardless — this plan's UI-level check exists to make the mismatch clear *before* the user tries to sign, not to replace that guard.
- `useCloseExecution.ts`'s existing signer/source and post-sign integrity checks are untouched by this plan — this plan only changes how a `TransactionSigner` gets constructed and offered to `run()`, never the trust-anchor or post-sign verification logic itself.
- Strict TypeScript, no `any`; explicit return types on exported functions (CONTRIBUTING.md).
- Prettier: double quotes, semicolons, printWidth 100.
- Comments only when the *why* is non-obvious (CLAUDE.md).
- No new automated tests are added in this plan: `useWalletKitConnection` and `WalletConnectPanel` are DOM/browser-extension-dependent in the same way `apps/web/lib/wallet-kit/client.ts` already is (undocumented/untested for that exact reason in the merged PR) — impractical to unit-test without a fragile DOM mock, and this repo has no component-test harness (React Testing Library, etc.) to lean on. Verification for this plan is type-check + lint + manual/live dev-server checks, matching how the CSP task in the merged PR was verified.

---

## File Structure

New files:
- `apps/web/hooks/useWalletKitConnection.ts` — connect/disconnect, mount-time session detection, network-mismatch check.

Moved files:
- `apps/web/components/execution/WalletConnectPanel.tsx` → `apps/web/components/wallet/WalletConnectPanel.tsx` (no longer execution-specific now that `AccountEntryForm` also uses it).

Modified files:
- `apps/web/components/wallet/WalletConnectPanel.tsx` (post-move) — becomes presentational, driven by the hook's return value instead of owning its own kit calls.
- `apps/web/components/execution/ExecutionWizard.tsx` — consumes `useWalletKitConnection` instead of its own `ensureWalletKitInitialized`/`KitEventType.DISCONNECT` subscription (added in the merged PR's final-review fix wave); reactively syncs the signer from the hook's `address`; adds the source-address/network mismatch notice.
- `apps/web/components/account-entry/AccountEntryForm.tsx` — gains a "Connect wallet" / "Paste address" tab switcher; wallet tab renders the shared `WalletConnectPanel`.
- `docs/architecture.md` §6.3 — note that the wallet connection made at account entry carries through to signing.

Not modified:
- `apps/web/lib/wallet-kit/client.ts`, `apps/web/lib/wallet-kit/modules.ts`, `apps/web/lib/stellar/signer.ts`, `apps/web/hooks/useCloseExecution.ts` — all untouched; this plan only changes how a signer gets constructed/offered in the UI layer.
- `apps/web/components/account-entry/AddressInput.tsx`, `apps/web/components/account-entry/SecretKeyInput.tsx` — untouched, still used for the "paste" paths.

---

### Task 1: `useWalletKitConnection` hook

**Files:**
- Create: `apps/web/hooks/useWalletKitConnection.ts`

**Interfaces:**
- Consumes: `ensureWalletKitInitialized` (`apps/web/lib/wallet-kit/client.ts`), `KitEventType` (`@creit-tech/stellar-wallets-kit/types`), `Network`/`NETWORK_PASSPHRASES` (`apps/web/config/networks.ts`).
- Produces:
  ```ts
  export interface WalletKitConnection {
    address: string | null;
    connecting: boolean;
    error: string | null;
    networkMismatch: boolean;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
  }
  export function useWalletKitConnection(network: Network): WalletKitConnection;
  ```
  Tasks 2 and 3 both call this hook and pass its return value into `WalletConnectPanel`.

- [ ] **Step 1: Implement the hook**

Create `apps/web/hooks/useWalletKitConnection.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

export interface WalletKitConnection {
  address: string | null;
  connecting: boolean;
  error: string | null;
  /** True once a wallet is connected but its active network doesn't match this
   *  page's network — connected, but not usable until resolved. */
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

/**
 * Owns the wallet-kit connection lifecycle for any screen that needs it: connect,
 * disconnect, detecting a session already established elsewhere in the flow (the
 * kit is a static singleton that persists `activeAddress`/`selectedModuleId` to
 * localStorage, so a wallet connected during account entry is still connected by
 * the time the user reaches the sign step — this hook is what notices that,
 * instead of requiring a fresh click), and flagging a wallet/app network mismatch.
 */
export function useWalletKitConnection(network: Network): WalletKitConnection {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);

  const checkNetworkMismatch = useCallback(async (): Promise<boolean> => {
    try {
      const kit = ensureWalletKitInitialized(network);
      const { networkPassphrase } = await kit.getNetwork();
      return networkPassphrase !== NETWORK_PASSPHRASES[network];
    } catch {
      // Some wallets don't implement getNetwork (e.g. LOBSTR via its own module,
      // per the kit's own source) — treat as unknown, not a mismatch.
      return false;
    }
  }, [network]);

  // Detect a session already connected earlier in the flow, instead of requiring
  // a fresh click every time this hook mounts on a new page. `checkNetworkMismatch`
  // is a pure function (not a state setter) precisely so this effect's `cancelled`
  // guard can cover its result too — a naive version that let it set state directly
  // could still fire after unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kit = ensureWalletKitInitialized(network);
        const { address: existing } = await kit.getAddress();
        if (cancelled) return;
        setAddress(existing);
        const mismatch = await checkNetworkMismatch();
        if (!cancelled) setNetworkMismatch(mismatch);
      } catch {
        // No existing session — nothing to restore.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, checkNetworkMismatch]);

  useEffect(() => {
    try {
      const kit = ensureWalletKitInitialized(network);
      return kit.on(KitEventType.DISCONNECT, () => {
        setAddress(null);
        setNetworkMismatch(false);
      });
    } catch {
      return undefined;
    }
  }, [network]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const kit = ensureWalletKitInitialized(network);
      const { address: connected } = await kit.authModal();
      setAddress(connected);
      setNetworkMismatch(await checkNetworkMismatch());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the wallet.");
    } finally {
      setConnecting(false);
    }
  }, [network, checkNetworkMismatch]);

  const disconnect = useCallback(async () => {
    setError(null);
    try {
      await ensureWalletKitInitialized(network).disconnect();
      setAddress(null);
      setNetworkMismatch(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect the wallet.");
    }
  }, [network]);

  return { address, connecting, error, networkMismatch, connect, disconnect };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: this alone won't fully compile yet — nothing calls this hook until Tasks 2/3, so it should type-check standalone with no errors reported against this new file. If an error appears against `useWalletKitConnection.ts` itself, fix it before continuing; an error elsewhere is out of scope for this step.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/useWalletKitConnection.ts
git commit -m "feat(web): add useWalletKitConnection hook for shared wallet-connection lifecycle"
```

---

### Task 2: Move `WalletConnectPanel` and make it presentational

**Files:**
- Delete: `apps/web/components/execution/WalletConnectPanel.tsx`
- Create: `apps/web/components/wallet/WalletConnectPanel.tsx`

**Interfaces:**
- Consumes: `WalletKitConnection` (Task 1).
- Produces:
  ```tsx
  interface WalletConnectPanelProps {
    connection: WalletKitConnection;
    disabled?: boolean;
    /** Shown instead of the normal connected state when the connected wallet is
     *  valid but wrong for the current context (e.g. doesn't match the account
     *  being closed). Absent/undefined means no such context-specific check applies. */
    mismatchWarning?: string;
  }
  export default function WalletConnectPanel(props: WalletConnectPanelProps): JSX.Element;
  ```
  Task 3 (`ExecutionWizard`) and Task 4 (`AccountEntryForm`) both render this component, importing from its new path `@/components/wallet/WalletConnectPanel`.

- [ ] **Step 1: Create the new file, delete the old one**

Run: `mkdir -p apps/web/components/wallet`

Create `apps/web/components/wallet/WalletConnectPanel.tsx`:

```tsx
"use client";

import type { JSX } from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import type { WalletKitConnection } from "@/hooks/useWalletKitConnection";

interface Props {
  connection: WalletKitConnection;
  disabled?: boolean;
  /** Shown instead of the normal connected state when the connected wallet is
   *  valid but wrong for the current context (e.g. doesn't match the account
   *  being closed). Absent/undefined means no such context-specific check applies. */
  mismatchWarning?: string;
}

export default function WalletConnectPanel({
  connection,
  disabled,
  mismatchWarning,
}: Props): JSX.Element {
  const { address, connecting, error, networkMismatch, connect, disconnect } = connection;

  if (address) {
    const warning = mismatchWarning ?? (networkMismatch ? "Your wallet is on a different network than this page. Switch networks in your wallet, or disconnect and reconnect the right one." : null);

    return (
      <div className="space-y-1.5">
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
        {warning && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {warning}
          </p>
        )}
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

Then delete the old file: `rm apps/web/components/execution/WalletConnectPanel.tsx`

- [ ] **Step 2: Type-check**

Run: `bun run --filter '@lumenwipe/web' type-check`
Expected: **FAILS**, with exactly one error, in `apps/web/components/execution/ExecutionWizard.tsx` (`Cannot find module './WalletConnectPanel'` or similar) — the only remaining reference to the old path, fixed in Task 3. If any other file reports an error, stop and investigate.

- [ ] **Step 3: Commit**

```bash
git add -A apps/web/components/wallet/WalletConnectPanel.tsx apps/web/components/execution/WalletConnectPanel.tsx
git commit -m "refactor(web): move WalletConnectPanel to components/wallet and make it presentational"
```

(`git add -A` here is scoped to these two paths — one add, one delete — not the whole tree.)

---

### Task 3: Wire `ExecutionWizard` to the shared hook

**Files:**
- Modify: `apps/web/components/execution/ExecutionWizard.tsx`

**Interfaces:**
- Consumes: `useWalletKitConnection` (Task 1), `WalletConnectPanel` from its new path (Task 2).

- [ ] **Step 1: Replace the full contents of `ExecutionWizard.tsx`**

```tsx
"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { cn } from "@/lib/utils/cn";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
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
  const sourceAddress = useDemolishStore((s) => s.sourceAddress);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const phase = useDemolishStore((s) => s.phase);
  const lastError = useDemolishStore((s) => s.lastError);

  const { run, progressStatus } = useCloseExecution();
  const walletConnection = useWalletKitConnection(network);
  const [mode, setMode] = useState<SignMode>("wallet");
  const [keyEntered, setKeyEntered] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // True once the user has explicitly chosen the secret-key path over an available,
  // matching wallet. Without this, the reactive sync effect below would immediately
  // re-populate the wallet signer on the very next render — it's still connected
  // and still matching in the background — undoing the user's choice. Reset when
  // the user explicitly switches back to the wallet tab.
  const [walletDismissed, setWalletDismissed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);

  const walletAddressMatchesSource =
    walletConnection.address !== null && walletConnection.address === sourceAddress;
  const signerReady = mode === "wallet" ? walletAddress !== null : keyEntered;

  const clearSigner = useCallback(() => {
    secretKeyRef.current = "";
    signerRef.current = null;
    setKeyEntered(false);
    setWalletAddress(null);
  }, []);

  // Sync the active signer from the shared wallet-connection hook — this covers
  // both an explicit "Connect wallet" click AND a session already connected during
  // account entry, which the hook detects on mount without any click at all. Only
  // treat the connected wallet as the active signer when it matches the account
  // actually being closed, its network matches the app's, and the user hasn't
  // explicitly dismissed it in favor of the secret-key path; a mismatch on either
  // axis is surfaced by WalletConnectPanel's `mismatchWarning`/`networkMismatch`
  // instead of being silently accepted or silently ignored.
  //
  // The `else if (walletAddress !== null)` branch matters beyond the obvious
  // "wallet disconnected" case: `useWalletKitConnection` commits `address` and
  // `networkMismatch` in two separate state updates (there's a real `await`
  // between them), so this effect can fire once with a matching address and no
  // known mismatch yet, populate the signer, and then fire again a moment later
  // once the mismatch becomes known. Without this branch, that second run would
  // hit neither condition and leave the already-populated (but now known-bad)
  // signer in place — this branch is what actually retracts it. It only ever
  // clears the *wallet* side (checked via `walletAddress`, not `keyEntered`), so
  // it can never stomp a live `SecretKeySigner`.
  useEffect(() => {
    if (
      !walletDismissed &&
      walletConnection.address &&
      walletAddressMatchesSource &&
      !walletConnection.networkMismatch
    ) {
      signerRef.current = new WalletKitSigner(walletConnection.address, (xdr, opts) =>
        ensureWalletKitInitialized(network).signTransaction(xdr, opts)
      );
      setWalletAddress(walletConnection.address);
      // A connected wallet supersedes any previously entered secret key, for the
      // same reason the secret-key handler supersedes a connected wallet below:
      // the secret-key tab must not keep showing "loaded" once a different signer
      // is what `execute()` will actually use.
      secretKeyRef.current = "";
      setKeyEntered(false);
    } else if (walletAddress !== null) {
      signerRef.current = null;
      setWalletAddress(null);
    }
  }, [
    walletConnection.address,
    walletConnection.networkMismatch,
    walletAddressMatchesSource,
    walletDismissed,
    walletAddress,
    network,
  ]);

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
        // which one `execute()` will actually use. Marking the wallet dismissed also
        // stops the reactive sync effect above from immediately re-populating it
        // just because it's still connected in the background.
        setWalletAddress(null);
        setWalletDismissed(true);
      } else if (!walletAddress) {
        // Only clear the shared signer if a wallet isn't the one currently holding
        // it — otherwise typing an incomplete key while a wallet is connected would
        // silently discard the wallet's signer without any visible feedback.
        signerRef.current = null;
      }
    },
    [walletAddress]
  );

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
  const walletMismatchWarning =
    walletConnection.address && !walletAddressMatchesSource
      ? `Connected to ${walletConnection.address.slice(0, 4)}…${walletConnection.address.slice(-4)}, but you're closing ${sourceAddress ? `${sourceAddress.slice(0, 4)}…${sourceAddress.slice(-4)}` : "a different account"}. Disconnect and reconnect the right wallet.`
      : undefined;

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
              Every transaction is verified against your own choices — destination, asset decisions,
              and memo — before it is signed. Anything unexpected is rejected.
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
                  onClick={() => {
                    setMode("wallet");
                    // Explicitly re-engaging the wallet tab re-arms the reactive
                    // sync effect above, so an already-connected, matching wallet
                    // is picked back up without requiring another "Connect" click.
                    setWalletDismissed(false);
                  }}
                  className={cn(
                    "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
                    mode === "wallet"
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:text-white/80"
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
                  connection={walletConnection}
                  disabled={running}
                  mismatchWarning={walletMismatchWarning}
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

Note the changes from the previous version: `sourceAddress` is now read from the store (it wasn't before); the old standalone `useEffect` that manually subscribed to `KitEventType.DISCONNECT` is gone (the hook owns that now); `onWalletConnected`/`onWalletDisconnected` callbacks are gone (replaced by the reactive sync effect watching `walletConnection.address`); `WalletConnectPanel` is imported from its new path and takes `connection`/`mismatchWarning` instead of `network`/`address`/`onConnected`/`onDisconnected`.

- [ ] **Step 2: Type-check and lint**

Run: `bun run --filter '@lumenwipe/web' type-check && bun run --filter '@lumenwipe/web' lint`
Expected: both PASS.

- [ ] **Step 3: Run the full unit test suite**

Run: `cd apps/web && bun test tests/unit`
Expected: PASS, same count as before this plan (196) — this plan adds no new test files and doesn't touch any tested module (`close-engine.ts`, `verify.ts`, `signer.ts`, `wallet-kit/modules.ts` are all untouched).

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/execution/ExecutionWizard.tsx
git commit -m "refactor(web): wire ExecutionWizard to the shared wallet-connection hook"
```

---

### Task 4: Wallet-connect on `AccountEntryForm`

**Files:**
- Modify: `apps/web/components/account-entry/AccountEntryForm.tsx`

**Interfaces:**
- Consumes: `useWalletKitConnection` (Task 1), `WalletConnectPanel` from its new path (Task 2).

- [ ] **Step 1: Replace the full contents of `AccountEntryForm.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { cn } from "@/lib/utils/cn";
import AddressInput from "./AddressInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";

type EntryMode = "wallet" | "address";

export default function AccountEntryForm() {
  const router = useRouter();
  const network = useNetworkStore((s) => s.network);
  const { setPhase, initSession } = useDemolishStore();
  const walletConnection = useWalletKitConnection(network);

  const [mode, setMode] = useState<EntryMode>("wallet");
  const [pastedSource, setPastedSource] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = mode === "wallet" ? (walletConnection.address ?? "") : pastedSource;
  const canProceed =
    isValidGAddress(source) && !(mode === "wallet" && walletConnection.networkMismatch);

  async function handleAnalyze() {
    if (!canProceed) return;
    setAnalyzing(true);
    setError(null);

    try {
      // Validate that source account exists before navigating
      const res = await fetch(`/api/${network}/account/${source}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Account not found on this network.");
        return;
      }

      initSession();
      setPhase("ANALYZING");

      router.push(`/${network}/analyze?source=${source}`);
    } catch {
      setError("Failed to connect to the Stellar network. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-white">
          Account to close
          <span className="text-destructive ml-1">*</span>
        </label>

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
            onClick={() => setMode("address")}
            className={cn(
              "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
              mode === "address" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
            )}
          >
            Paste address
          </button>
        </div>

        {mode === "wallet" ? (
          <WalletConnectPanel connection={walletConnection} disabled={analyzing} />
        ) : (
          <AddressInput
            label=""
            value={pastedSource}
            onChange={setPastedSource}
            placeholder="G... (the account to merge)"
          />
        )}

        <p className="text-xs text-muted-foreground">
          We&apos;ll analyze this account&apos;s state so you can review and decide what happens to
          each balance before choosing a destination.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <button
        onClick={handleAnalyze}
        disabled={!canProceed || analyzing}
        className="w-full flex items-center justify-center gap-2 bg-stellar text-black font-semibold py-3 px-4 rounded-xl hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
      >
        {analyzing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing account...
          </>
        ) : (
          <>
            Analyze account
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </div>
  );
}
```

Note: the account-to-close label and required-asterisk moved out of `AddressInput` (which had its own internal `label`) to a shared label above the tab switcher, since both tabs now need to share one heading. `AddressInput` is still used for the "paste" tab, just with an empty `label` prop and no `helpText`/`required` (the shared text below the tabs replaces both). `isValidGAddress` gates `canProceed` the same way regardless of which tab supplied `source`, so a connected wallet's address is validated identically to a pasted one (defense in depth — the kit should only ever return valid G-addresses, but this doesn't assume that).

- [ ] **Step 2: Type-check and lint**

Run: `bun run --filter '@lumenwipe/web' type-check && bun run --filter '@lumenwipe/web' lint`
Expected: both PASS.

- [ ] **Step 3: Run the full unit test suite**

Run: `cd apps/web && bun test tests/unit`
Expected: PASS, same count as Task 3's check (this task adds no new test files either).

- [ ] **Step 4: Manual smoke test**

Run `bun run dev:api` and `bun dev` per CLAUDE.md's local full-flow dev setup, open `/testnet`, and confirm:
- The "Connect wallet" tab is selected by default; connecting a testnet-funded Freighter account fills the address as a non-editable pill and enables "Analyze account".
- Switching to "Paste address" and typing a valid testnet address works exactly as before.
- After analyzing and reaching `/testnet/execute`, the same wallet is already shown as connected on the wallet tab — no reconnect click needed — and "Sign & execute close" is enabled once the confirmation checkbox is checked (no need to re-verify the whole close flow end-to-end here; the merged wallet-kit-integration PR already covers that).
- Disconnect the wallet from the browser extension directly (not through the app's Disconnect button) and confirm the app notices — this exercises the `DISCONNECT` event path now owned by the hook.
- To exercise the mismatch notice: connect Wallet A on `/testnet`, analyze, then on `/testnet/execute` switch the active account in the browser extension to Wallet B before doing anything else — the wallet tab should show a warning naming both addresses, not silently enable "Sign & execute close".

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/account-entry/AccountEntryForm.tsx
git commit -m "feat(web): add wallet-connect as an entry-point way to supply the account to close"
```

---

### Task 5: Update `docs/architecture.md` §6.3

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Locate the relevant text**

Run: `grep -n "6.3 Wallet integration" docs/architecture.md`

- [ ] **Step 2: Add one clause**

In §6.3's opening sentence (currently starting "Signing has two paths. The primary path, implemented as the default wallet tab in the ExecutionWizard, is..."), add that the same wallet connection can also be made earlier, at account entry, and carries through automatically. Keep the edit small — one sentence or clause, not a new section.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: document wallet-connect at account entry carrying through to signing"
```

---

## Self-Review Notes

- **Spec coverage:** shared hook (Task 1), presentational panel + relocation (Task 2), execute-step consumption + mismatch UI (Task 3), entry-point tab (Task 4), docs (Task 5) — covers every piece of the approved design, including both clarifying decisions (persistent connection across the flow; fixed non-editable pill; network-mismatch check added to the same touch point).
- **Placeholder scan:** no TBD/TODO; full file contents given for every modified/created file since each is a near-total rewrite, not a small patch — a task's implementer reading tasks out of order needs the whole file.
- **Type consistency:** `WalletKitConnection` (Task 1) is consumed identically by `WalletConnectPanel` (Task 2), `ExecutionWizard` (Task 3), and `AccountEntryForm` (Task 4). `WalletConnectPanel`'s `{ connection, disabled?, mismatchWarning? }` props (Task 2) match exactly how Tasks 3 and 4 call it.
