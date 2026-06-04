"use client";

import { useRef, useState } from "react";
import { Eye, EyeOff, CheckCircle, XCircle, ShieldAlert } from "lucide-react";
import { isValidSecretKey } from "@/lib/utils/validation";
import { cn } from "@/lib/utils/cn";

interface SecretKeyInputProps {
  label?: string;
  onKeyChange?: (isValid: boolean) => void;
  getKey: () => string;
  setKeyRef: (ref: React.RefObject<string | null>) => void;
  disabled?: boolean;
  placeholder?: string;
}

// External ref pattern: caller passes a ref that this component populates
interface SecretKeyRef {
  ref: React.RefObject<string | null>;
}

// Simpler controlled pattern: caller manages the ref
export interface SecretKeyHandle {
  getSecretKey: () => string;
  clearKey: () => void;
  isValid: () => boolean;
}

interface Props {
  label?: string;
  secretKeyRef: React.MutableRefObject<string>;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

export default function SecretKeyInput({
  label = "Secret key",
  secretKeyRef,
  onValidityChange,
  disabled,
}: Props) {
  const [showKey, setShowKey] = useState(false);
  const [displayValue, setDisplayValue] = useState("");
  const [touched, setTouched] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDisplayValue(val);
    secretKeyRef.current = val;
    onValidityChange?.(isValidSecretKey(val));
  };

  const isValid = displayValue ? isValidSecretKey(displayValue) : null;
  const showError = touched && displayValue && !isValid;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-white">
        {label}
        <span className="text-destructive ml-1">*</span>
      </label>

      <div className="relative">
        <input
          type={showKey ? "text" : "password"}
          value={displayValue}
          onChange={handleChange}
          onBlur={() => setTouched(true)}
          placeholder="S..."
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          className={cn(
            "w-full font-mono-address bg-black/30 border rounded-lg px-3 py-2.5 pr-16 text-sm",
            "placeholder:text-white/30",
            "focus:outline-none focus:ring-2 focus:ring-stellar/40",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            showError ? "border-destructive" : "border-white/10",
            isValid && touched ? "border-emerald-500/50" : ""
          )}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {touched &&
            displayValue &&
            (isValid ? (
              <CheckCircle className="h-4 w-4 text-emerald-500" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" />
            ))}
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="text-white/50 hover:text-white transition-colors p-0.5"
            tabIndex={-1}
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {showError && (
        <p className="text-xs text-destructive">
          Not a valid Stellar secret key (must start with S)
        </p>
      )}

      <p className="flex items-start gap-1.5 text-xs text-white/50">
        <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
        Your secret key never leaves your browser. It is held in memory only during signing.
      </p>
    </div>
  );
}
