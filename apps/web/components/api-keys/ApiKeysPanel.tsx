"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { KeyRound, RefreshCw, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import type { Network } from "@/config/networks";
import { toUserMessage } from "@/lib/utils/user-error";
import { ensureWalletKitInitialized, selectedWalletId } from "@/lib/wallet-kit/client";
import {
  IntegratorRequestError,
  createKey,
  createSession,
  endSession,
  getSession,
  listKeys,
  requestChallenge,
  revokeKey,
  rotateKey,
  type KeyList,
  type KeyRecord,
  type Session,
} from "@/lib/integrator/client";
import {
  MESSAGE_SIGNING_WALLETS,
  WalletSignInError,
  isContractAddress,
  messageSigningSupport,
  normalizeSignature,
  signChallenge,
  verifySignedMessage,
  walletName,
  walletNetworkPassphrase,
} from "@/lib/integrator/wallet-sign-in";
import type { PollarAccount, PollarSignInProps } from "./PollarSignIn";

export const API_DOCS_URL = "https://docs.lumenwipe.com/api-reference/introduction";
export const SDK_DOCS_URL = "https://docs.lumenwipe.com/sdk/overview";
export const QUICKSTART_URL = `${SDK_DOCS_URL}#quickstart`;
/** The API's defaults, as the API reference states them. */
export const MAX_ACTIVE_KEYS = 5;
export const SESSION_MINUTES = 30;
export const DEFAULT_KEY_RATE_LIMIT = { requests: 120, windowSeconds: 60 } as const;

/** The kit's network for this page. A wallet that reports its own network signs the message on
 *  that one instead; the signature is the same either way. */
const KIT_NETWORK: Network = "mainnet";

export const SESSION_ENDED = "Your session ended. Sign in again to manage your keys.";
export const SIGNED_OUT = "You signed out.";

const ERROR_ID = "api-keys-error";
const WALLETS = `${MESSAGE_SIGNING_WALLETS.slice(0, -1).join(", ")} or ${MESSAGE_SIGNING_WALLETS.at(-1)}`;

type View = "restoring" | "signed-out" | "signed-in";
type Busy = "wallet" | "pollar" | "keys" | "signout" | null;
type Notice =
  | { kind: "contract_account" }
  | { kind: "unsupported_wallet"; walletId: string | null }
  | { kind: "not_configured" }
  | null;

export interface ApiKeysPanelProps {
  /** Google and GitHub sign-in, present only when Pollar is configured. */
  pollar?: ComponentType<PollarSignInProps>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const SIGN_IN_ERRORS: Record<"signer_mismatch" | "bad_signature", string> = {
  signer_mismatch:
    "Your wallet signed with a different account than the one it connected. Switch to that account in the wallet and try again.",
  bad_signature: "We could not verify your wallet's signature. Please try again.",
};

export default function ApiKeysPanel({ pollar: PollarSlot }: ApiKeysPanelProps) {
  const [view, setView] = useState<View>("restoring");
  const [session, setSession] = useState<Session | null>(null);
  const [list, setList] = useState<KeyList | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusSignIn, setFocusSignIn] = useState(false);
  const signInRef = useRef<HTMLButtonElement>(null);
  const revealedRef = useRef<HTMLHeadingElement>(null);
  const pollarLogout = useRef<(() => Promise<void> | void) | null>(null);
  const signedInWithPollar = useRef(false);

  const endLocally = useCallback((message: string) => {
    setView("signed-out");
    setSession(null);
    setList(null);
    setConfirming(null);
    setAnnouncement(message);
    setFocusSignIn(true);
  }, []);

  const guarded = useCallback(
    async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
      setBusy(kind);
      setError(null);
      try {
        await action();
      } catch (e) {
        const signingIn = kind === "wallet" || kind === "pollar";
        if (e instanceof IntegratorRequestError) {
          if (e.code === "integrator_api_not_configured") setNotice({ kind: "not_configured" });
          else if (e.status === 401 && !signingIn) endLocally(SESSION_ENDED);
          else setError(e.message);
        } else if (e instanceof WalletSignInError) {
          if (e.reason === "contract_account") setNotice({ kind: "contract_account" });
          else if (e.reason === "unsupported_wallet") {
            setNotice({ kind: "unsupported_wallet", walletId: e.walletId });
          } else setError(SIGN_IN_ERRORS[e.reason]);
        } else {
          setError(toUserMessage(e, kind === "wallet" ? "wallet" : "generic"));
        }
      } finally {
        setBusy(null);
      }
    },
    [endLocally]
  );

  useEffect(() => {
    let cancelled = false;
    getSession().then(
      (restored) => {
        if (cancelled) return;
        setSession(restored);
        setView("signed-in");
      },
      (e: unknown) => {
        if (cancelled) return;
        if (e instanceof IntegratorRequestError && e.code === "integrator_api_not_configured") {
          setNotice({ kind: "not_configured" });
        }
        setView("signed-out");
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view !== "signed-in" || list) return;
    void guarded("keys", async () => setList(await listKeys()));
  }, [view, list, guarded]);

  useEffect(() => {
    if (view !== "signed-in" || !session) return undefined;
    const timer = setTimeout(
      () => endLocally(SESSION_ENDED),
      Math.max(Date.parse(session.expiresAt) - Date.now(), 0)
    );
    return () => clearTimeout(timer);
  }, [view, session, endLocally]);

  useEffect(() => {
    if (!focusSignIn || view !== "signed-out") return;
    signInRef.current?.focus();
    setFocusSignIn(false);
  }, [focusSignIn, view]);

  useEffect(() => {
    if (revealed) revealedRef.current?.focus();
  }, [revealed]);

  const finishSignIn = useCallback(async (address: string, message: string, signature: string) => {
    const started = await createSession(address, message, signature);
    setNotice(null);
    setSession(started);
    setList(null);
    setView("signed-in");
    setAnnouncement("Signed in.");
  }, []);

  const signInWithWallet = () =>
    guarded("wallet", async () => {
      setNotice(null);
      const kit = ensureWalletKitInitialized(KIT_NETWORK);
      const { address } = await kit.authModal();
      const walletId = selectedWalletId(kit);
      if (isContractAddress(address)) throw new WalletSignInError("contract_account", walletId);
      if (messageSigningSupport(walletId) === "no") {
        throw new WalletSignInError("unsupported_wallet", walletId);
      }
      const { message } = await requestChallenge(address);
      const passphrase = await walletNetworkPassphrase(kit);
      const signature = await signChallenge(kit, walletId, address, message, passphrase);
      await finishSignIn(address, message, signature);
      signedInWithPollar.current = false;
    });

  const onPollarAccount = useCallback(
    (account: PollarAccount) =>
      void guarded("pollar", async () => {
        setNotice(null);
        if (account.smart || isContractAddress(account.address)) {
          throw new WalletSignInError("contract_account");
        }
        const { message } = await requestChallenge(account.address);
        const signature = normalizeSignature(await account.sign(message));
        if (!signature || !verifySignedMessage(account.address, message, signature)) {
          throw new WalletSignInError("bad_signature");
        }
        await finishSignIn(account.address, message, signature);
        signedInWithPollar.current = true;
      }),
    [guarded, finishSignIn]
  );

  const onPollarLogoutChange = useCallback((logout: (() => Promise<void> | void) | null) => {
    pollarLogout.current = logout;
  }, []);

  const signOut = () =>
    guarded("signout", async () => {
      await endSession();
      // The wallet kit stays connected: its remembered wallet is shared with the close flow, which
      // may be running in another tab.
      if (signedInWithPollar.current) {
        try {
          await pollarLogout.current?.();
        } catch {
          // The key session is already gone; Pollar's own sign-in grants nothing here without a
          // new signature.
        }
      }
      signedInWithPollar.current = false;
      endLocally(SIGNED_OUT);
    });

  const onCreate = () =>
    guarded("keys", async () => {
      const created = await createKey();
      setRevealed(created.key);
      setList(await listKeys());
    });

  const onRotate = (id: string) =>
    guarded("keys", async () => {
      const created = await rotateKey(id);
      setRevealed(created.key);
      setConfirming(null);
      setList(await listKeys());
    });

  const onRevoke = (id: string) =>
    guarded("keys", async () => {
      await revokeKey(id);
      setConfirming(null);
      setList(await listKeys());
    });

  const describedBy = error ? ERROR_ID : undefined;
  const signingIn = busy === "wallet" || busy === "pollar";
  const active = list?.keys.filter((k) => !k.revokedAt) ?? [];
  const revokedCount = (list?.keys.length ?? 0) - active.length;

  return (
    <div className="space-y-5">
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {notice?.kind === "not_configured" && (
        <Callout tone="warning" title="Key management is not available right now">
          Sign-in and key management are switched off on this server, so no key can be created here
          at the moment. Try again in a few minutes. Meanwhile, read how authentication works in the{" "}
          <a className="underline" href={API_DOCS_URL}>
            API reference
          </a>{" "}
          or start with the{" "}
          <a className="underline" href={SDK_DOCS_URL}>
            SDK overview
          </a>
          .
        </Callout>
      )}

      {error && (
        <Callout tone="danger" id={ERROR_ID}>
          {error}
        </Callout>
      )}

      {revealed && (
        <Card tone="success">
          <CardBody>
            <h2 ref={revealedRef} tabIndex={-1} className="text-sm font-semibold text-white">
              Copy your key now. You will not be able to see it again.
            </h2>
            <div className="mt-3 flex items-start gap-2">
              <code className="mkt-mono block min-w-0 flex-1 break-all rounded-control bg-black/30 p-3 text-xs text-white/90">
                {revealed}
              </code>
              <CopyButton value={revealed} label="API key" visibleFeedback />
            </div>
            <Button variant="secondary" className="mt-3" onClick={() => setRevealed(null)}>
              I have saved it
            </Button>
          </CardBody>
        </Card>
      )}

      {view === "restoring" && (
        <p className="flex items-center gap-2 text-sm text-white/60">
          <Spinner label="Checking for an existing session" />
          <span aria-hidden="true">Checking for an existing session...</span>
        </p>
      )}

      {view === "signed-out" && (
        <Card>
          <CardBody className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Sign in to manage your keys</h2>
              <p className="mt-1 text-sm text-white/65">
                Your wallet signs a one-time message to prove it owns the address. It is not a
                transaction: it moves no funds and costs no fee.
              </p>
            </div>
            <Button
              ref={signInRef}
              icon={<Wallet aria-hidden="true" className="h-4 w-4" />}
              loading={busy === "wallet"}
              disabled={signingIn}
              aria-describedby={describedBy}
              onClick={() => void signInWithWallet()}
            >
              {busy === "wallet" ? "Waiting for your wallet..." : "Sign in with a Stellar wallet"}
            </Button>

            {notice?.kind === "unsupported_wallet" && (
              <Callout tone="warning" title={`${walletName(notice.walletId)} cannot sign in here`}>
                Signing in needs a signed message, and {walletName(notice.walletId)} cannot sign
                one. Choose {WALLETS} instead, or WalletConnect with a phone wallet that signs
                messages.
                {PollarSlot ? " You can also continue with Google or GitHub below." : ""}
              </Callout>
            )}

            {notice?.kind === "contract_account" && (
              <Callout tone="warning" title="Contract accounts cannot own keys yet">
                This account is a contract account (its address starts with C, as passkey smart
                wallets do). Signing in needs a signature from a single account key, which a
                contract account does not have. Sign in with a regular account (its address starts
                with G) from {WALLETS}
                {PollarSlot ? ", or continue with Google or GitHub" : ""}. The key it owns works for
                every account you analyze or close, not only its own.
              </Callout>
            )}

            {!PollarSlot && (
              <Callout announce={false}>
                Google and GitHub sign-in are not set up here. Sign in with a Stellar wallet above
                instead: {WALLETS} can sign the sign-in message.
              </Callout>
            )}
            {busy === "pollar" && (
              <p className="flex items-center gap-2 text-sm text-white/60">
                <Spinner label="Verifying your account" />
                <span aria-hidden="true">Verifying your account...</span>
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {PollarSlot && (
        <PollarSlot
          signedIn={view !== "signed-out"}
          disabled={signingIn}
          onAccount={onPollarAccount}
          onLogoutChange={onPollarLogoutChange}
        />
      )}

      {view === "signed-in" && session && (
        <Card>
          <CardBody className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-fg-muted">
              <div className="min-w-0">
                <p className="mkt-mono truncate">Signed in as {session.address}</p>
                <p>
                  Session ends at{" "}
                  <time dateTime={session.expiresAt}>{formatTime(session.expiresAt)}</time>
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "signout"}
                aria-describedby={describedBy}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>

            {!list ? (
              <p className="flex items-center gap-2 text-sm text-white/60">
                <Spinner label="Loading your keys" />
                <span aria-hidden="true">Loading your keys...</span>
              </p>
            ) : (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Your keys</h2>
                    {list.usage && (
                      <p className="mt-1 text-xs text-fg-muted">
                        {list.usage.today} requests today · {list.usage.last30Days} in the last 30
                        days
                      </p>
                    )}
                  </div>
                  <Button
                    icon={<KeyRound aria-hidden="true" className="h-4 w-4" />}
                    loading={busy === "keys"}
                    disabled={busy !== null}
                    aria-describedby={describedBy}
                    onClick={() => void onCreate()}
                  >
                    Create key
                  </Button>
                </div>

                {active.length === 0 ? (
                  <p className="mt-6 text-sm text-white/60">You have no active keys yet.</p>
                ) : (
                  <ul className="mt-5 divide-y divide-white/6">
                    {active.map((key) => (
                      <KeyRow
                        key={key.id}
                        record={key}
                        busy={busy !== null}
                        confirming={confirming === key.id}
                        onAskConfirm={() => setConfirming(key.id)}
                        onCancel={() => setConfirming(null)}
                        onRotate={() => void onRotate(key.id)}
                        onRevoke={() => void onRevoke(key.id)}
                      />
                    ))}
                  </ul>
                )}
                {revokedCount > 0 && (
                  <p className="mt-4 text-xs text-fg-subtle">{revokedCount} revoked or rotated</p>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <HowKeysWork />
    </div>
  );
}

function HowKeysWork() {
  return (
    <section aria-labelledby="how-keys-work" className="rounded-card border border-edge/10 p-5">
      <h2 id="how-keys-work" className="text-base font-semibold text-white">
        How keys work
      </h2>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-white/70">
        <li>
          A wallet can hold up to {MAX_ACTIVE_KEYS} active keys. Revoke one to create another.
        </li>
        <li>
          Signing in lasts {SESSION_MINUTES} minutes, then you sign in again. It only manages keys;
          it is not an API key.
        </li>
        <li>
          Each key has its own rate limit: {DEFAULT_KEY_RATE_LIMIT.requests} requests per{" "}
          {DEFAULT_KEY_RATE_LIMIT.windowSeconds} seconds by default.
        </li>
        <li>
          A new key is shown once. Keep it on your server and call the API from your backend, never
          from a browser app.
        </li>
      </ul>
      <p className="mt-4 text-sm text-white/70">
        Next: follow the{" "}
        <a className="underline" href={QUICKSTART_URL}>
          SDK quickstart
        </a>
        , or read the{" "}
        <a className="underline" href={API_DOCS_URL}>
          API reference
        </a>{" "}
        and the{" "}
        <a className="underline" href={SDK_DOCS_URL}>
          SDK overview
        </a>
        .
      </p>
    </section>
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
  const name = record.label || `Key ${record.id.slice(0, 8)}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="mkt-mono text-xs text-white/80">{name}</p>
        <p className="text-xs text-fg-subtle">Created {formatDate(record.createdAt)}</p>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-white/70">Revoke or rotate this key?</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}
            onClick={props.onRotate}
          >
            Rotate
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
            onClick={props.onRevoke}
          >
            Revoke
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`Manage ${name}`}
          onClick={props.onAskConfirm}
        >
          Manage
        </Button>
      )}
    </li>
  );
}
