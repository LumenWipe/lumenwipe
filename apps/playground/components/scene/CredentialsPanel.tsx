"use client";

import { useEffect, useState } from "react";
import { Check, ClipboardCopy, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { credentialsErrorCopy } from "@/lib/error-copy";
import { PlaygroundApiError, playgroundRequest } from "@/lib/playground-api";

/** How long a revealed secret stays on screen before it is masked again. */
export const REVEAL_SECONDS = 30;

interface Credentials {
  publicKey: string;
  secretKey: string;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy the ${label}`}
      className="shrink-0 rounded p-1.5 text-subtle transition-colors hover:text-white/80"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-stellar" aria-hidden />
      ) : (
        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * The demo's keys, for closing it in the real tool. Fetched only on request and only while the
 * countdown runs; the secret is masked until revealed, masked again after REVEAL_SECONDS, and
 * dropped with this panel, which its parent remounts when the countdown ends.
 */
export default function CredentialsPanel({
  sessionId,
  timeUp,
  buttonClassName,
}: {
  sessionId: string;
  timeUp: boolean;
  buttonClassName: string;
}) {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealLeft, setRevealLeft] = useState(0);
  const revealed = revealLeft > 0;

  useEffect(() => {
    if (revealLeft <= 0) return;
    const id = setTimeout(() => setRevealLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [revealLeft]);

  async function fetchCredentials() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setCredentials(
        await playgroundRequest<Credentials>(fetch, `/session/${sessionId}/credentials`)
      );
    } catch (err) {
      setError(credentialsErrorCopy(err instanceof PlaygroundApiError ? err.code : null));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        onClick={() => void fetchCredentials()}
        disabled={loading || !!credentials || timeUp}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <ExternalLink className="h-4 w-4" aria-hidden />
        )}
        Try the demolish flow yourself
      </button>

      {error && (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-white/80">
          {error}
        </p>
      )}

      {credentials && (
        <div className="mt-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
          <p className="mkt-eyebrow mb-1.5 text-[0.6rem] text-subtle">Demo account credentials</p>
          <p className="mb-2.5 text-[11px] leading-relaxed text-subtle">
            This key controls a testnet demo account that is about to be merged away. It holds test
            XLM only. Paste the public key as the account to close in the demolish tool; the secret
            key is what you sign with, asked at execution time and never stored.
          </p>
          <div className="mb-3 space-y-2">
            <div>
              <p className="mb-1 mkt-mono text-[11px] text-subtle">Public key</p>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-all mkt-mono text-[11px] text-white/70">
                  {credentials.publicKey}
                </span>
                <CopyButton text={credentials.publicKey} label="public key" />
              </div>
            </div>
            <div>
              <p className="mb-1 mkt-mono text-[11px] text-subtle">Secret key</p>
              <div className="flex items-center gap-2">
                <span
                  className={`min-w-0 flex-1 break-all [overflow-wrap:anywhere] mkt-mono text-[11px] ${
                    revealed ? "text-value" : "text-subtle"
                  }`}
                >
                  {revealed ? (
                    credentials.secretKey
                  ) : (
                    <>
                      <span className="sr-only">Hidden</span>
                      <span aria-hidden>
                        {"S" + "•".repeat(27)}
                        <br />
                        {"•".repeat(28)}
                      </span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setRevealLeft(revealed ? 0 : REVEAL_SECONDS)}
                  aria-label={revealed ? "Hide the secret key" : "Reveal the secret key"}
                  className="shrink-0 rounded p-1.5 text-subtle transition-colors hover:text-white/80"
                >
                  {revealed ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                  )}
                </button>
                {revealed && <CopyButton text={credentials.secretKey} label="secret key" />}
              </div>
              {revealed && (
                <p className="mt-1 text-[11px] text-subtle">Hides again in {revealLeft} s</p>
              )}
            </div>
          </div>
          <a
            href="https://lumenwipe.com/testnet"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-3 py-2 text-xs text-stellar transition-opacity hover:opacity-80"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open the demolish tool in a new tab
          </a>
        </div>
      )}
    </>
  );
}
