"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, Input } from "@/components/ui/field";
import type { Network } from "@/config/networks";
import type { CreateKeyRequest } from "@/lib/integrator/client";
import { cn } from "@/lib/utils/cn";

/** The API's label rule: trimmed, 1 to 64 code points, no control or format characters. */
export const LABEL_MAX = 64;
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

export const LABEL_ERROR = `Use up to ${LABEL_MAX} printable characters.`;
export const NETWORKS_ERROR = "Choose all networks, mainnet only or testnet only.";

export type Scope = "all" | Network;

export const SCOPES: readonly { value: Scope; label: string }[] = [
  { value: "all", label: "All networks" },
  { value: "mainnet", label: "Mainnet only" },
  { value: "testnet", label: "Testnet only" },
];

export type CreateKeyFailure = { field: "label" | "networks" | "form"; message: string };
/** "created" resets the form; a failure the form can place is shown on its field; null means the
 *  panel already reported it. */
export type CreateOutcome = "created" | CreateKeyFailure | null;

export function labelLength(raw: string): number {
  return [...raw.trim()].length;
}

export function labelProblem(raw: string): string | null {
  const label = raw.trim();
  if (!label) return null;
  return labelLength(label) > LABEL_MAX || LABEL_FORBIDDEN.test(label) ? LABEL_ERROR : null;
}

/** The body for a label and scope: a blank label and "All networks" are left out. */
export function createRequest(rawLabel: string, scope: Scope): CreateKeyRequest {
  const label = rawLabel.trim();
  return {
    ...(label ? { label } : {}),
    ...(scope === "all" ? {} : { networks: [scope] }),
  };
}

export interface CreateKeyFormProps {
  /** Any key action is running, so this one waits. */
  busy: boolean;
  /** A key action of this panel is running: the button shows it. */
  loading: boolean;
  atLimit: boolean;
  maxKeys: number;
  /** The panel's own error, when one is showing. */
  describedBy?: string;
  onCreate: (request: CreateKeyRequest) => Promise<CreateOutcome>;
}

export default function CreateKeyForm({
  busy,
  loading,
  atLimit,
  maxKeys,
  describedBy,
  onCreate,
}: CreateKeyFormProps) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [failure, setFailure] = useState<CreateKeyFailure | null>(null);
  const [focusFailure, setFocusFailure] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const firstScopeRef = useRef<HTMLInputElement>(null);

  const headingId = `${id}-heading`;
  const scopeHintId = `${id}-scope-hint`;
  const scopeErrorId = `${id}-scope-error`;
  const formErrorId = `${id}-form-error`;
  const limitId = `${id}-limit`;
  const length = labelLength(label);

  useEffect(() => {
    if (!focusFailure || !failure) return;
    if (failure.field === "label") labelRef.current?.focus();
    if (failure.field === "networks") firstScopeRef.current?.focus();
    setFocusFailure(false);
  }, [focusFailure, failure]);

  const fail = (next: CreateKeyFailure) => {
    setFailure(next);
    setFocusFailure(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || atLimit) return;
    const problem = labelProblem(label);
    if (problem) return fail({ field: "label", message: problem });
    setFailure(null);
    const outcome = await onCreate(createRequest(label, scope));
    if (outcome === "created") {
      setLabel("");
      setScope("all");
    } else if (outcome) {
      fail(outcome);
    }
  };

  const submitDescribedBy =
    [atLimit && limitId, failure?.field === "form" && formErrorId, describedBy]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <form
      noValidate
      aria-labelledby={headingId}
      className="mt-5 space-y-4 rounded-card border border-line p-4"
      onSubmit={(event) => void submit(event)}
    >
      <h3 id={headingId} className="text-sm font-semibold text-fg">
        Create a key
      </h3>

      <Field
        label="Label (optional)"
        error={failure?.field === "label" ? failure.message : undefined}
        helper={
          <span className="flex flex-wrap justify-between gap-2">
            <span>Up to {LABEL_MAX} characters, so you can tell your keys apart.</span>
            <span aria-hidden="true" className={cn(length > LABEL_MAX && "text-danger-fg")}>
              {length}/{LABEL_MAX}
            </span>
          </span>
        }
      >
        <Input
          ref={labelRef}
          name="label"
          autoComplete="off"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      {length >= LABEL_MAX && (
        <p role="status" className="sr-only">
          {length === LABEL_MAX
            ? `The label is at the ${LABEL_MAX}-character limit.`
            : `The label is over the ${LABEL_MAX}-character limit.`}
        </p>
      )}

      <fieldset
        aria-describedby={
          failure?.field === "networks" ? `${scopeErrorId} ${scopeHintId}` : scopeHintId
        }
        aria-invalid={failure?.field === "networks" ? true : undefined}
        className="space-y-1.5"
      >
        <legend className="text-sm font-medium text-fg">Networks</legend>
        <div className="flex flex-wrap gap-2 pt-1.5">
          {SCOPES.map((option, index) => (
            <label
              key={option.value}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-sm",
                scope === option.value
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-line-strong text-fg-muted"
              )}
            >
              <input
                ref={index === 0 ? firstScopeRef : undefined}
                type="radio"
                name={`${id}-scope`}
                value={option.value}
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
                className="h-4 w-4 shrink-0 accent-accent"
              />
              {option.label}
            </label>
          ))}
        </div>
        {failure?.field === "networks" && (
          <p id={scopeErrorId} role="alert" className="text-xs text-danger-fg">
            {failure.message}
          </p>
        )}
        <p id={scopeHintId} className="text-xs text-fg-muted">
          Scope is fixed when the key is created; rotating the key keeps it. A key limited to one
          network is refused on routes that take no network.
        </p>
      </fieldset>

      {failure?.field === "form" && (
        <Callout tone="danger" id={formErrorId}>
          {failure.message}
        </Callout>
      )}
      {atLimit && (
        <Callout tone="warning" announce="status" id={limitId}>
          You have {maxKeys} active keys, the most a wallet can hold. Revoke or rotate one under
          Manage to create another.
        </Callout>
      )}

      <Button
        type="submit"
        icon={<KeyRound aria-hidden="true" className="h-4 w-4" />}
        loading={loading}
        disabled={busy || atLimit}
        aria-describedby={submitDescribedBy}
      >
        Create key
      </Button>
    </form>
  );
}
