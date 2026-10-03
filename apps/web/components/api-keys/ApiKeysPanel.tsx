"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePollar } from "@pollar/react";
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import {
  IntegratorRequestError,
  createKey,
  createSession,
  listKeys,
  requestChallenge,
  revokeKey,
  rotateKey,
  type KeyList,
  type KeyRecord,
} from "@/lib/integrator/client";

const BUTTON =
  "inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-white/85 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BUTTON} border-stellar/40 bg-stellar/10`;

function message(error: unknown): string {
  return error instanceof IntegratorRequestError
    ? error.message
    : "Something went wrong. Please try again.";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ApiKeysPanel() {
  const { isAuthenticated, wallet, login, logout, getClient, configStatus } = usePollar();
  const [token, setToken] = useState<string | null>(null);
  const [list, setList] = useState<KeyList | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedInFor = useRef<string | null>(null);

  const address = wallet?.address ?? null;
  const unsupported = isAuthenticated && wallet?.custody === "smart";

  const reset = useCallback(() => {
    setToken(null);
    setList(null);
    setRevealed(null);
    setConfirming(null);
    signedInFor.current = null;
  }, []);

  const guarded = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        if (e instanceof IntegratorRequestError && e.status === 401) reset();
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [reset]
  );

  const signIn = useCallback(
    (forAddress: string) =>
      guarded(async () => {
        const { message: challenge } = await requestChallenge(forAddress);
        const proof = await getClient().stellar.sep53.signMessage(challenge);
        if (proof.status !== "signed") {
          throw new IntegratorRequestError("We could not verify your wallet. Please try again.", 0);
        }
        const session = await createSession(forAddress, challenge, proof.signature);
        setToken(session.token);
        setList(await listKeys(session.token));
      }),
    [guarded, getClient]
  );

  useEffect(() => {
    if (!isAuthenticated || !address || unsupported || signedInFor.current === address) return;
    signedInFor.current = address;
    void signIn(address);
  }, [isAuthenticated, address, unsupported, signIn]);

  useEffect(() => {
    if (!isAuthenticated) reset();
  }, [isAuthenticated, reset]);

  const refresh = useCallback(async (t: string) => setList(await listKeys(t)), []);

  const onCreate = () =>
    guarded(async () => {
      const created = await createKey(token!);
      setRevealed(created.key);
      setCopied(false);
      await refresh(token!);
    });

  const onRotate = (id: string) =>
    guarded(async () => {
      const created = await rotateKey(token!, id);
      setRevealed(created.key);
      setCopied(false);
      setConfirming(null);
      await refresh(token!);
    });

  const onRevoke = (id: string) =>
    guarded(async () => {
      await revokeKey(token!, id);
      setConfirming(null);
      await refresh(token!);
    });

  const onCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select the key and copy it manually.");
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
        <p className="text-sm text-white/70">Continue with an account to manage your keys.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className={PRIMARY}
            disabled={configStatus !== "ready"}
            onClick={() => login({ provider: "google" })}
          >
            Continue with Google
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={configStatus !== "ready"}
            onClick={() => login({ provider: "github" })}
          >
            Continue with GitHub
          </button>
        </div>
      </div>
    );
  }

  if (unsupported) {
    return (
      <div role="alert" className="rounded-2xl border border-warning/30 bg-warning/5 p-6 text-sm">
        <p>Passkey smart wallets cannot sign in here yet. Use Google or GitHub instead.</p>
        <button type="button" className={`${BUTTON} mt-4`} onClick={logout}>
          Sign out
        </button>
      </div>
    );
  }

  const active = list?.keys.filter((k) => !k.revokedAt) ?? [];
  const revokedCount = (list?.keys.length ?? 0) - active.length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 text-xs text-white/55">
        <span className="mkt-mono truncate">Signed in as {address}</span>
        <button type="button" className="underline hover:text-white" onClick={logout}>
          Sign out
        </button>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
          {error}
        </p>
      )}

      {revealed && (
        <div role="status" className="rounded-2xl border border-stellar/30 bg-stellar/5 p-5">
          <p className="text-sm font-medium text-white">
            Copy your key now. You will not be able to see it again.
          </p>
          <code className="mkt-mono mt-3 block break-all rounded-lg bg-black/30 p-3 text-xs text-white/90">
            {revealed}
          </code>
          <div className="mt-3 flex gap-3">
            <button type="button" className={PRIMARY} onClick={onCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy key"}
            </button>
            <button type="button" className={BUTTON} onClick={() => setRevealed(null)}>
              I have saved it
            </button>
          </div>
        </div>
      )}

      {!token || !list ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-white/60" aria-live="polite">
            {busy ? "Verifying your wallet..." : "Your wallet is not verified yet."}
          </p>
          {!busy && address && (
            <button type="button" className={BUTTON} onClick={() => void signIn(address)}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Your keys</h2>
              <p className="mt-1 text-xs text-white/55">
                {list.requestsSinceStart} requests since the API last restarted
              </p>
            </div>
            <button type="button" className={PRIMARY} disabled={busy} onClick={onCreate}>
              <KeyRound className="h-4 w-4" />
              Create key
            </button>
          </div>

          {active.length === 0 ? (
            <p className="mt-6 text-sm text-white/60">You have no active keys yet.</p>
          ) : (
            <ul className="mt-5 divide-y divide-white/6">
              {active.map((key) => (
                <KeyRow
                  key={key.id}
                  record={key}
                  busy={busy}
                  confirming={confirming === key.id}
                  onAskConfirm={() => setConfirming(key.id)}
                  onCancel={() => setConfirming(null)}
                  onRotate={() => onRotate(key.id)}
                  onRevoke={() => onRevoke(key.id)}
                />
              ))}
            </ul>
          )}
          {revokedCount > 0 && (
            <p className="mt-4 text-xs text-white/45">{revokedCount} revoked or rotated</p>
          )}
        </div>
      )}
    </div>
  );
}

function KeyRow(props: {
  record: KeyRecord;
  busy: boolean;
  confirming: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const { record, busy, confirming } = props;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="mkt-mono text-xs text-white/80">Key {record.id.slice(0, 8)}</p>
        <p className="text-xs text-white/45">Created {formatDate(record.createdAt)}</p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/70">Revoke or rotate this key?</span>
          <button type="button" className={BUTTON} disabled={busy} onClick={props.onRotate}>
            <RefreshCw className="h-3.5 w-3.5" />
            Rotate
          </button>
          <button type="button" className={BUTTON} disabled={busy} onClick={props.onRevoke}>
            <Trash2 className="h-3.5 w-3.5" />
            Revoke
          </button>
          <button type="button" className="underline" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={BUTTON} disabled={busy} onClick={props.onAskConfirm}>
          Manage
        </button>
      )}
    </li>
  );
}
