"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, CheckCircle, ShieldAlert } from "lucide-react";
import { couldBeSecretKey, isValidSecretKey } from "@/lib/utils/validation";
import { Field, Input } from "@/components/ui/field";

interface Props {
  label?: string;
  secretKeyRef: React.MutableRefObject<string>;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

/** A secret seed's length: a value this long that does not parse is wrong, not unfinished. */
const SECRET_KEY_LENGTH = 56;

/**
 * Uncontrolled on purpose: React copies a controlled input's `value` into the DOM `value`
 * attribute, password type included, which would put the key in the page's markup. The key lives
 * only in the input's own value and in `secretKeyRef`, and state holds nothing derived from it
 * beyond booleans.
 *
 * Checked as it is typed: a value that can no longer become a key, or one at full length that does
 * not parse, is flagged at once; one still being typed is flagged only when the field is left.
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
  const [finished, setFinished] = useState(false);

  // A browser's form restoration would otherwise refill the field behind `hasValue`.
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  // A partly typed or mistyped key goes with the field: nothing of it stays in the caller's ref
  // once the field is gone, whether it was valid or not.
  useEffect(() => {
    const held = secretKeyRef;
    return () => {
      held.current = "";
    };
  }, [secretKeyRef]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // A pasted key often brings a newline or spaces with it: they are not part of the key.
    const val = e.target.value.trim();
    const valid = isValidSecretKey(val);
    setHasValue(e.target.value !== "");
    setIsValid(valid);
    setFinished(!couldBeSecretKey(val) || val.length >= SECRET_KEY_LENGTH);
    secretKeyRef.current = val;
    onValidityChange?.(valid);
  };

  const showError = hasValue && !isValid && (touched || finished);
  const showValid = hasValue && isValid;

  return (
    <Field
      label={label}
      required
      error={showError ? "Not a valid Stellar secret key (must start with S)" : undefined}
      status={showValid ? "Valid secret key" : undefined}
      helper={
        <span className="flex items-start gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          <span>
            Anyone who has this key controls the account. Your secret key never leaves your browser.
            It is held in memory only, never persisted, and cleared when you finish, leave, or click
            Forget key.
          </span>
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
          className="pr-10 font-mono"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
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
      {/* Visible text for sighted users; assistive technology reads the same words as the
          field's description, so this copy is hidden from it. */}
      {showValid && (
        <p aria-hidden="true" className="flex items-center gap-1 text-xs text-success">
          <CheckCircle className="h-3 w-3 shrink-0" />
          Valid secret key
        </p>
      )}
    </Field>
  );
}
