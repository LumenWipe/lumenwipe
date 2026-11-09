"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, ClipboardCopy, Dices, Link2, Minus, Plus } from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";
import {
  FEATURE_SETS,
  NO_SCENARIOS_REASON,
  SCENARIOS,
  encodeSelection,
  formatReplayCode,
  generateRandomSelection,
  newReplayCode,
  parseReplayCode,
  presetSelection,
  setScenarioParam,
  toggleScenario,
  validateSelection,
  type FeatureSetId,
  type ScenarioId,
} from "@/lib/scenarios";

function durationLabel(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`;
  return `~${Math.round(seconds / 60)} min`;
}

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
  const step =
    "flex h-6 w-6 items-center justify-center rounded border border-white/15 text-white/40 hover:border-white/30 hover:text-white/70 disabled:opacity-30 transition-colors";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-white/60">{label}</span>
      <div className="flex items-center gap-1">
        <button
          aria-label={`Fewer ${label.toLowerCase()}`}
          onClick={() => onChange(value - 1)}
          disabled={value <= min}
          className={step}
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-5 text-center mkt-mono text-xs text-white/80">{value}</span>
        <button
          aria-label={`More ${label.toLowerCase()}`}
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          className={step}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/** A parameter that picks one named option; its value is the option's index from `min`. */
function Choice({
  label,
  value,
  min,
  choices,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  choices: readonly string[];
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs text-white/60">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-xs text-white/80"
      >
        {choices.map((name, i) => (
          <option key={name} value={min + i}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Arrow keys, Home and End move focus along a row of buttons. */
function rovingFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const current = buttons.findIndex((b) => b === document.activeElement);
  const last = buttons.length - 1;
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? current === last
        ? 0
        : current + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? current <= 0
          ? last
          : current - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : null;
  if (next === null) return;
  event.preventDefault();
  buttons[next]?.focus();
}

/** Copies `text`, and says so for a moment. */
function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return [copied, copy];
}

/** Applies a replay code; false when it is not one or this deployment can run none of its wallet. */
export function replaySeed(code: string): boolean {
  const { unavailable, setSelection } = usePlaygroundStore.getState();
  const parsed = parseReplayCode(code);
  const selection =
    parsed && generateRandomSelection(parsed.seed, { version: parsed.version, unavailable });
  if (!parsed || !selection) return false;
  setSelection(selection, "random", formatReplayCode(parsed.seed, parsed.version));
  return true;
}

/** The preset row and the scenario toggles, with the live cost and the steps the run will take. */
export default function ScenarioPicker() {
  const selection = usePlaygroundStore((s) => s.selection);
  const preset = usePlaygroundStore((s) => s.preset);
  const unavailable = usePlaygroundStore((s) => s.unavailable);
  const setSelection = usePlaygroundStore((s) => s.setSelection);
  const seed = usePlaygroundStore((s) => s.seed);
  const [copied, copy] = useCopy();
  const [replayText, setReplayText] = useState("");
  const [replayError, setReplayError] = useState(false);

  const options = { unavailable };
  const result = validateSelection(selection, options);
  const selected = new Set(selection.scenarios.map((c) => c.id));

  function choosePreset(id: FeatureSetId): void {
    const next = presetSelection(id, options);
    if (next) setSelection(next, id);
  }

  function rollRandom(): void {
    replaySeed(newReplayCode());
  }

  function submitReplay(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const ok = replaySeed(replayText);
    setReplayError(!ok);
    if (ok) setReplayText("");
  }

  function selectionLink(): string {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?selection=${encodeSelection(selection)}`;
  }

  function toggle(id: ScenarioId): void {
    setSelection(toggleScenario(selection, id, !selected.has(id), options), null);
  }

  function setParam(id: ScenarioId, name: string, value: number): void {
    setSelection(setScenarioParam(selection, id, name, value, options), null);
  }

  const chip = (active: boolean): string =>
    `rounded-lg border px-3 py-2 text-left text-[11px] transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
      active
        ? "border-stellar/50 bg-stellar/10 text-white"
        : "border-white/10 bg-white/[0.02] text-white/60 hover:border-white/20 hover:text-white/80"
    }`;

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Presets"
        onKeyDown={rovingFocus}
        className="grid grid-cols-2 gap-1.5"
      >
        {FEATURE_SETS.map((set) => {
          const available = presetSelection(set.id, options) !== null;
          const reasonId = `preset-reason-${set.id}`;
          return (
            // aria-disabled rather than disabled, so the row stays reachable by keyboard and the
            // reason stays readable.
            <button
              key={set.id}
              aria-pressed={preset === set.id}
              aria-disabled={!available}
              aria-describedby={available ? undefined : reasonId}
              onClick={() => available && choosePreset(set.id)}
              className={chip(preset === set.id)}
            >
              <span className="font-semibold">{set.label}</span>
              {!available && (
                <span id={reasonId} className="mt-0.5 block text-[10px] text-white/35">
                  {NO_SCENARIOS_REASON}
                </span>
              )}
            </button>
          );
        })}
        <button
          aria-pressed={preset === "random"}
          onClick={rollRandom}
          className={chip(preset === "random")}
        >
          <span className="flex items-center gap-1 font-semibold">
            <Dices className="h-3 w-3" />
            Random wallet
          </span>
        </button>
      </div>

      {preset === "random" && seed && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-3 py-2">
          <span className="text-[11px] text-white/60">
            Replay code <span className="mkt-mono text-stellar">{seed}</span>
          </span>
          <span className="flex items-center gap-2">
            <button
              aria-label="Copy the replay code"
              onClick={() => copy("seed", seed)}
              className="text-white/50 hover:text-white/80"
            >
              {copied === "seed" ? (
                <Check className="h-3 w-3 text-stellar" />
              ) : (
                <ClipboardCopy className="h-3 w-3" />
              )}
            </button>
            <button onClick={rollRandom} className="text-[11px] text-white/50 hover:text-white/80">
              New seed
            </button>
          </span>
        </div>
      )}

      <form onSubmit={submitReplay} className="flex items-center gap-1.5">
        <label htmlFor="replay-seed" className="sr-only">
          Replay a seed
        </label>
        <input
          id="replay-seed"
          value={replayText}
          onChange={(e) => setReplayText(e.target.value)}
          placeholder="Replay a seed, e.g. LW1-7Q2M4KD9"
          aria-invalid={replayError}
          aria-describedby={replayError ? "replay-seed-error" : undefined}
          maxLength={16}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 mkt-mono text-[11px] text-white/80 placeholder:text-white/30"
        />
        <button
          type="submit"
          className="rounded-md border border-white/15 px-2.5 py-1.5 text-[11px] text-white/70 hover:bg-white/5"
        >
          Replay
        </button>
      </form>
      {replayError && (
        <p id="replay-seed-error" className="text-[10px] text-value">
          That is not a replay code this playground can run. One looks like LW1-7Q2M4KD9.
        </p>
      )}

      {FEATURE_SETS.map((set) => {
        const scenarios = SCENARIOS.filter((s) => s.featureSet === set.id);
        if (scenarios.length === 0) return null;
        return (
          <fieldset key={set.id} className="space-y-1.5">
            <legend className="mkt-eyebrow mb-1 text-[0.6rem] text-white/40">{set.label}</legend>
            {scenarios.map((def) => {
              const on = selected.has(def.id);
              const reason = unavailable.get(def.id);
              const choice = selection.scenarios.find((c) => c.id === def.id);
              const reasonId = `scenario-reason-${def.id}`;
              return (
                <div key={def.id} className="rounded-lg border border-white/10 bg-white/[0.02]">
                  <button
                    aria-pressed={on}
                    aria-describedby={reason === undefined ? undefined : reasonId}
                    disabled={reason !== undefined}
                    onClick={() => toggle(def.id)}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={`text-xs ${on ? "text-white" : "text-white/60"}`}>
                      {def.label}
                    </span>
                    <span className="text-[10px] leading-tight text-white/40">
                      {def.description}
                    </span>
                  </button>
                  {reason !== undefined && (
                    <p id={reasonId} className="px-3 pb-2 text-[10px] text-value">
                      {reason}
                    </p>
                  )}
                  {on && choice && Object.keys(def.params).length > 0 && (
                    <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                      {Object.entries(def.params).map(([name, spec]) =>
                        spec.choices ? (
                          <Choice
                            key={name}
                            label={spec.label}
                            value={choice.params[name] ?? spec.default}
                            min={spec.min}
                            choices={spec.choices}
                            onChange={(v) => setParam(def.id, name, v)}
                          />
                        ) : (
                          <Counter
                            key={name}
                            label={spec.label}
                            value={choice.params[name] ?? spec.default}
                            min={spec.min}
                            max={spec.max}
                            onChange={(v) => setParam(def.id, name, v)}
                          />
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        );
      })}

      <div
        aria-live="polite"
        className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-white/60"
      >
        {result.ok ? (
          <>
            <dl className="grid grid-cols-3 gap-2 mkt-mono text-[10px]">
              <div>
                <dt className="text-white/35">XLM at risk</dt>
                <dd className="text-white/80">{result.plan.cost.xlm}</dd>
              </div>
              <div>
                <dt className="text-white/35">Transactions</dt>
                <dd className="text-white/80">{result.plan.steps.length}</dd>
              </div>
              <div>
                <dt className="text-white/35">Estimated</dt>
                <dd className="text-white/80">{durationLabel(result.plan.cost.seconds)}</dd>
              </div>
            </dl>
            <ol aria-label="Steps before the close" className="mt-2 space-y-0.5 text-[10px]">
              {result.plan.steps.map((step) => (
                <li key={step.id}>{step.label}</li>
              ))}
            </ol>
            <button
              onClick={() => copy("link", selectionLink())}
              className="mt-2 flex items-center gap-1 text-[10px] text-white/50 hover:text-white/80"
            >
              {copied === "link" ? (
                <Check className="h-3 w-3 text-stellar" />
              ) : (
                <Link2 className="h-3 w-3" />
              )}
              Copy exact selection
            </button>
          </>
        ) : (
          <p>{result.message}</p>
        )}
      </div>
    </div>
  );
}
