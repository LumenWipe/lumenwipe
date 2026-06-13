"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bomb,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Eye,
  EyeOff,
  ExternalLink,
  FlaskConical,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";
import {
  DEFAULT_CUSTOM_CONFIG,
  PLAYGROUND_MODE_CONFIGS,
  estimateCustomDuration,
  maxOfferCount,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/playground/mess-plan";

// ─── Countdown badge ─────────────────────────────────────────────────────────

function CountdownBadge({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <span className="flex items-center gap-1 mkt-mono text-[10px] text-white/40">
      <TimerReset className="h-3 w-3" />
      session {mm}:{ss}
    </span>
  );
}

// ─── Copy button ─────────────────────────────────────────────────────────────

interface Credentials {
  publicKey: string;
  secretKey: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={handleCopy}
      className="shrink-0 text-white/40 hover:text-white/70 transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-stellar" /> : <ClipboardCopy className="h-3 w-3" />}
    </button>
  );
}

// ─── Duration label ───────────────────────────────────────────────────────────

function durationLabel(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`;
  const mins = Math.round(seconds / 60);
  return `~${mins} min`;
}

// ─── Counter spinner ──────────────────────────────────────────────────────────

function Counter({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-white/60">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="flex h-6 w-6 items-center justify-center rounded border border-white/15 text-white/40 hover:border-white/30 hover:text-white/70 disabled:opacity-30 transition-colors"
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-5 text-center mkt-mono text-xs text-white/80">{value}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="flex h-6 w-6 items-center justify-center rounded border border-white/15 text-white/40 hover:border-white/30 hover:text-white/70 disabled:opacity-30 transition-colors"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Mode selector ─────────────────────────────────────────────────────────────

function ModeSelector({
  selected,
  custom,
  onSelectMode,
  onCustomChange,
}: {
  selected: PlaygroundMode;
  custom: PlaygroundCustomConfig;
  onSelectMode: (m: PlaygroundMode) => void;
  onCustomChange: (c: PlaygroundCustomConfig) => void;
}) {
  const [customOpen, setCustomOpen] = useState(selected === "custom");

  const estimatedSeconds =
    selected === "custom"
      ? estimateCustomDuration(custom)
      : (PLAYGROUND_MODE_CONFIGS.find((m) => m.mode === selected)?.estimatedSeconds ?? 0);

  function handleModeClick(m: PlaygroundMode) {
    onSelectMode(m);
    if (m === "custom") setCustomOpen(true);
    else setCustomOpen(false);
  }

  function patchCustom(patch: Partial<PlaygroundCustomConfig>) {
    const next = { ...custom, ...patch };
    // Cap offerCount if trustlineCount decreased.
    const cap = maxOfferCount(next.trustlineCount);
    if (next.offerCount > cap) next.offerCount = cap;
    onCustomChange(next);
  }

  const ICONS: Record<PlaygroundMode, string> = {
    light: "⚡",
    standard: "◎",
    full: "✦",
    custom: "⚙",
  };

  return (
    <div className="space-y-2">
      {/* Mode cards */}
      <div className="grid grid-cols-2 gap-1.5">
        {PLAYGROUND_MODE_CONFIGS.map((cfg) => {
          const active = selected === cfg.mode;
          const secs =
            cfg.mode === "custom" ? estimateCustomDuration(custom) : cfg.estimatedSeconds;
          return (
            <button
              key={cfg.mode}
              onClick={() => handleModeClick(cfg.mode)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-stellar/50 bg-stellar/10 text-white"
                  : "border-white/10 bg-white/[0.02] text-white/60 hover:border-white/20 hover:text-white/80"
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[11px] font-semibold flex items-center gap-1">
                  <span>{ICONS[cfg.mode]}</span>
                  {cfg.label}
                </span>
                {cfg.mode === "full" && (
                  <span className="rounded-full bg-stellar/20 px-1.5 py-px text-[0.55rem] text-stellar font-medium">
                    All
                  </span>
                )}
              </div>
              <p className="text-[10px] text-white/40 leading-tight">{cfg.description}</p>
              {secs > 0 && (
                <p className="mt-1 text-[10px] text-white/30 mkt-mono">{durationLabel(secs)}</p>
              )}
            </button>
          );
        })}
      </div>

      {/* Custom config panel */}
      {selected === "custom" && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
          <button
            onClick={() => setCustomOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs text-white/50 hover:text-white/70 transition-colors"
          >
            <span>Configure</span>
            {customOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {customOpen && (
            <div className="border-t border-white/10 px-3 py-3 space-y-2.5">
              <Counter
                label="Trustlines"
                value={custom.trustlineCount}
                min={1}
                max={5}
                onChange={(v) => patchCustom({ trustlineCount: v })}
              />
              <Counter
                label="DEX offers"
                value={custom.offerCount}
                min={0}
                max={maxOfferCount(custom.trustlineCount)}
                onChange={(v) => patchCustom({ offerCount: v })}
              />
              <Counter
                label="Data entries"
                value={custom.dataEntryCount}
                min={0}
                max={5}
                onChange={(v) => patchCustom({ dataEntryCount: v })}
              />
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <span className="text-xs text-white/60">Extra signer</span>
                <button
                  onClick={() => patchCustom({ addSigner: !custom.addSigner })}
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    custom.addSigner ? "bg-stellar" : "bg-white/15"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      custom.addSigner ? "translate-x-4" : ""
                    }`}
                  />
                </button>
              </div>
              <p className="text-[10px] text-white/30 mkt-mono pt-0.5">
                {durationLabel(estimateCustomDuration(custom))} estimated
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function PlaygroundControls({
  start,
  demolish,
  progressStatus,
}: {
  start: () => void;
  demolish: () => void;
  progressStatus: string | null;
}) {
  const phase = usePlaygroundStore((s) => s.phase);
  const expiresAt = usePlaygroundStore((s) => s.expiresAt);
  const lastError = usePlaygroundStore((s) => s.lastError);
  const accountState = usePlaygroundStore((s) => s.accountState);
  const executionPlan = usePlaygroundStore((s) => s.executionPlan);
  const recoveredXlm = usePlaygroundStore((s) => s.recoveredXlm);
  const sessionId = usePlaygroundStore((s) => s.sessionId);
  const selectedMode = usePlaygroundStore((s) => s.selectedMode);
  const customConfig = usePlaygroundStore((s) => s.customConfig);
  const setSelectedMode = usePlaygroundStore((s) => s.setSelectedMode);
  const setCustomConfig = usePlaygroundStore((s) => s.setCustomConfig);

  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [secretRevealed, setSecretRevealed] = useState(false);

  async function handleGetCredentials() {
    if (!sessionId || loadingCredentials) return;
    setLoadingCredentials(true);
    try {
      const res = await fetch(`/api/playground/session/${sessionId}/credentials`);
      if (!res.ok) throw new Error("Failed to load credentials");
      const data = (await res.json()) as Credentials;
      setCredentials(data);
    } catch {
      // silently ignore; user can retry
    } finally {
      setLoadingCredentials(false);
    }
  }

  const busy = phase === "CREATING_ACCOUNT" || phase === "MESSING" || phase === "DEMOLISHING";
  const lockedReserve = accountState ? 1 + accountState.numSubEntries * 0.5 : 0;
  const hasProgress = executionPlan.some((s) => s.status === "confirmed");

  const primaryButton =
    "flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 font-display text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  const modeLabel = PLAYGROUND_MODE_CONFIGS.find((m) => m.mode === selectedMode)?.label ?? "Demo";

  return (
    <div className="mkt-panel mkt-ticks relative rounded-lg p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="mkt-eyebrow text-white/50">Control panel</p>
        {expiresAt && phase !== "IDLE" && phase !== "COMPLETE" && (
          <CountdownBadge expiresAt={expiresAt} />
        )}
      </div>

      {phase === "IDLE" && (
        <>
          <ModeSelector
            selected={selectedMode}
            custom={customConfig}
            onSelectMode={setSelectedMode}
            onCustomChange={setCustomConfig}
          />

          <div className="my-4 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-white/45">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stellar/60" />
            <span>
              This sandbox is the <em>only</em> custodial part of LumenWipe - we create a throwaway
              testnet account so you can explore the full flow without a wallet.
            </span>
          </div>

          <button
            className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
            onClick={start}
          >
            <FlaskConical className="h-4 w-4" />
            {selectedMode === "light"
              ? "Quick demo"
              : selectedMode === "full"
                ? "Full stress test"
                : selectedMode === "custom"
                  ? "Run custom demo"
                  : "Create & trash a demo account"}
          </button>
        </>
      )}

      {busy && (
        <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-stellar" />
          <span className="text-sm text-white/70">{progressStatus ?? "Working..."}</span>
        </div>
      )}

      {phase === "DIRTY" && (
        <>
          <div className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75">
            The account is now a mess:{" "}
            <span className="text-value">{lockedReserve.toFixed(1)} XLM</span> locked in reserves
            across {accountState?.numSubEntries ?? 0} subentries. {executionPlan.length} steps to
            take it all apart.
          </div>
          <div className="flex flex-col gap-2">
            <button
              className={`${primaryButton} bg-value text-black hover:opacity-90`}
              onClick={demolish}
            >
              <Bomb className="h-4 w-4" />
              Demolish it here
            </button>
            <button
              className={`${primaryButton} border border-white/15 text-white/70 hover:bg-white/5`}
              onClick={() => void handleGetCredentials()}
              disabled={loadingCredentials || !!credentials}
            >
              {loadingCredentials ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              Try the demolish flow yourself
            </button>
          </div>

          {credentials && (
            <div className="mt-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
              <p className="mkt-eyebrow mb-1.5 text-[0.6rem] text-white/40">
                Demo account credentials
              </p>
              <p className="mb-2.5 text-[11px] leading-relaxed text-white/45">
                Paste the public key as the account to close in the demolish tool. The secret key is
                what you sign with - asked at execution time, never stored.
              </p>
              <div className="space-y-2 mb-3">
                <div>
                  <p className="mkt-mono text-[10px] text-white/35 mb-1">Public key</p>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-all mkt-mono text-[10px] text-white/60">
                      {credentials.publicKey}
                    </span>
                    <CopyButton text={credentials.publicKey} />
                  </div>
                </div>
                <div>
                  <p className="mkt-mono text-[10px] text-white/35 mb-1">Secret key</p>
                  <div className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 break-all [overflow-wrap:anywhere] mkt-mono text-[10px] ${
                        secretRevealed ? "text-value" : "text-white/25"
                      }`}
                    >
                      {secretRevealed ? (
                        credentials.secretKey
                      ) : (
                        <>
                          {"S" + "•".repeat(27)}
                          <br />
                          {"•".repeat(28)}
                        </>
                      )}
                    </span>
                    <button
                      onClick={() => setSecretRevealed((v) => !v)}
                      className="shrink-0 text-white/40 hover:text-white/70 transition-colors"
                    >
                      {secretRevealed ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </button>
                    {secretRevealed && <CopyButton text={credentials.secretKey} />}
                  </div>
                </div>
              </div>
              <Link
                href="/testnet"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-3 py-2 text-xs text-stellar transition-opacity hover:opacity-80"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open the demolish tool in a new tab
              </Link>
            </div>
          )}
        </>
      )}

      {phase === "COMPLETE" && (
        <>
          <div className="mb-4 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-4 py-3 text-sm text-white/75">
            {modeLabel} demo complete. The account was merged away
            {recoveredXlm ? (
              <>
                {" "}
                and its final{" "}
                <span className="text-stellar">{parseFloat(recoveredXlm).toFixed(2)} XLM</span>{" "}
                (junk reserves included) was recovered
              </>
            ) : (
              " and every locked reserve recovered"
            )}{" "}
            - check the activity log for the receipts.
          </div>
          <button
            className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
            onClick={start}
          >
            <RotateCcw className="h-4 w-4" />
            Run it again
          </button>
        </>
      )}

      {phase === "EXPIRED" && (
        <>
          <div className="mb-4 flex items-start gap-2 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-value" />
            <span>This demo session expired. Start a fresh one - it only takes a few seconds.</span>
          </div>
          <button
            className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
            onClick={start}
          >
            <FlaskConical className="h-4 w-4" />
            Start a new session
          </button>
        </>
      )}

      {phase === "ERROR" && (
        <>
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-white/75">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span className="break-words">{lastError ?? "Something went wrong."}</span>
          </div>
          <div className="flex gap-2">
            {hasProgress && (
              <button
                className={`${primaryButton} bg-value text-black hover:opacity-90`}
                onClick={demolish}
              >
                <Bomb className="h-4 w-4" />
                Resume demolish
              </button>
            )}
            <button
              className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
              onClick={start}
            >
              <RotateCcw className="h-4 w-4" />
              Start over
            </button>
          </div>
        </>
      )}
    </div>
  );
}
