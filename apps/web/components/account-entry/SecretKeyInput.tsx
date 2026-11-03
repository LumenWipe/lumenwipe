"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, CheckCircle, XCircle, ShieldAlert } from "lucide-react";
import { isValidSecretKey } from "@/lib/utils/validation";
import { Field, Input } from "@/components/ui/field";

interface Props {
  label?: string;
  secretKeyRef: React.MutableRefObject<string>;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

/**
 * Uncontrolled on purpose: React copies a controlled input's `value` into the DOM `value`
 * attribute, password type included, which would put the key in the page's markup. The key lives
 * only in the input's own value and in `secretKeyRef`, and state holds nothing derived from it
 * beyond two booleans.
 */
export default function SecretKeyInput({
  label = "Secret key",
  secretKeyRef,
  onValidityChange,
  disabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showKey, setShowKey] = useState(false);
  const [hasValue, setHasValue] = useState(false);
  const [isValid, setIsValid] = useState(false);
  const [touched, setTouched] = useState(false);

  // A browser's form restoration would otherwise refill the field behind `hasValue`.
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const valid = isValidSecretKey(val);
    setHasValue(val !== "");
    setIsValid(valid);
    secretKeyRef.current = val;
    onValidityChange?.(valid);
  };

  const showError = touched && hasValue && !isValid;

  return (
    <Field
      label={label}
      required
      error={showError ? "Not a valid Stellar secret key (must start with S)" : undefined}
      status={touched && hasValue && isValid ? "Valid secret key" : undefined}
      helper={
        <span className="flex items-start gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          Your secret key never leaves your browser. It is held in memory only, never persisted, and
          cleared when you finish, leave, or click Forget key.
        </span>
      }
    >
      <div className="relative">
        <Input
          ref={inputRef}
          type={showKey ? "text" : "password"}
          onChange={handleChange}
          onBlur={() => setTouched(true)}
          placeholder="S..."
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          className="pr-16 font-mono"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {touched &&
            hasValue &&
            (isValid ? (
              <CheckCircle className="h-4 w-4 text-success" />
            ) : (
              <XCircle className="h-4 w-4 text-danger-fg" />
            ))}
          <button
            type="button"
            aria-label="Show secret key"
            aria-pressed={showKey}
            onClick={() => setShowKey((v) => !v)}
            className="text-fg-muted hover:text-white transition-colors p-1"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </Field>
  );
}
