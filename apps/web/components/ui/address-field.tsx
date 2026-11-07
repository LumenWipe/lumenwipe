"use client";

import { useState, type ClipboardEvent, type ReactElement, type ReactNode } from "react";
import { CheckCircle, XCircle } from "lucide-react";
import { addressErrorMessage, couldBeSecretKey, SECRET_KEY_WARNING } from "@/lib/utils/validation";
import { cn } from "@/lib/utils/cn";
import { Field, Input } from "./field";

interface AddressFieldProps {
  label: ReactNode;
  hideLabel?: boolean;
  /** Receives what was typed with the surrounding whitespace removed and nothing else changed:
   *  this value is what `verify()` later compares a transaction against. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Shown at once and in place of the error this field would reveal on blur or paste. */
  error?: string | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  groupClassName?: string;
  inputClassName?: string;
}

export function AddressField({
  label,
  hideLabel,
  value,
  onChange,
  placeholder = "G...",
  helper,
  required,
  disabled,
  error,
  leading,
  trailing,
  groupClassName,
  inputClassName,
}: AddressFieldProps): ReactElement {
  const [touched, setTouched] = useState(false);
  // Only that a key was refused is kept, never the key.
  const [secretRefused, setSecretRefused] = useState(false);
  const revealed = touched && value ? addressErrorMessage(value) : null;
  const shown = secretRefused ? SECRET_KEY_WARNING : (error ?? revealed);

  function refuseSecret(): void {
    setSecretRefused(true);
    onChange("");
  }

  function handleChange(next: string): void {
    const trimmed = next.trim();
    if (couldBeSecretKey(next)) {
      refuseSecret();
      return;
    }
    setSecretRefused(false);
    onChange(trimmed);
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>): void {
    setTouched(true);
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (couldBeSecretKey(pasted)) {
      e.preventDefault();
      refuseSecret();
    }
  }
  const confirmed = touched && !!value && !addressErrorMessage(value);

  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      required={required}
      helper={helper}
      error={shown}
      status={confirmed ? "Valid address" : undefined}
    >
      <div className={cn("relative flex items-center gap-2", groupClassName)}>
        {leading}
        <Input
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => setTouched(true)}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          className={cn(
            "min-w-0 flex-1 pr-9 font-mono",
            confirmed && "border-success/50",
            inputClassName
          )}
        />
        {!trailing && (confirmed || shown) && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
            {confirmed ? (
              <CheckCircle aria-hidden="true" className="h-4 w-4 text-success" />
            ) : (
              <XCircle aria-hidden="true" className="h-4 w-4 text-danger-fg" />
            )}
          </span>
        )}
        {trailing}
      </div>
    </Field>
  );
}
