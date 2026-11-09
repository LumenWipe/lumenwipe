"use client";

import type { KeyboardEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";
import {
  FEATURE_SETS,
  NO_SCENARIOS_REASON,
  SCENARIOS,
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

/** The preset row and the scenario toggles, with the live cost and the steps the run will take. */
export default function ScenarioPicker() {
  const selection = usePlaygroundStore((s) => s.selection);
  const preset = usePlaygroundStore((s) => s.preset);
  const unavailable = usePlaygroundStore((s) => s.unavailable);
  const setSelection = usePlaygroundStore((s) => s.setSelection);

  const options = { unavailable };
  const result = validateSelection(selection, options);
  const selected = new Set(selection.scenarios.map((c) => c.id));

  function choosePreset(id: FeatureSetId): void {
    const next = presetSelection(id, options);
    if (next) setSelection(next, id);
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
      </div>

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
                      {Object.entries(def.params).map(([name, spec]) => (
                        <Counter
                          key={name}
                          label={spec.label}
                          value={choice.params[name] ?? spec.default}
                          min={spec.min}
                          max={spec.max}
                          onChange={(v) => setParam(def.id, name, v)}
                        />
                      ))}
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
          </>
        ) : (
          <p>{result.message}</p>
        )}
      </div>
    </div>
  );
}
