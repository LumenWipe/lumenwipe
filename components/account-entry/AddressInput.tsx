"use client";

import { useState } from "react";
import { CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { isValidGAddress } from "@/lib/utils/validation";
import { cn } from "@/lib/utils/cn";

interface AddressInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  disabled?: boolean;
}

export default function AddressInput({
  label,
  value,
  onChange,
  placeholder = "G...",
  helpText,
  required,
  disabled,
}: AddressInputProps) {
  const [touched, setTouched] = useState(false);
  const isValid = value ? isValidGAddress(value) : null;
  const showError = touched && value && !isValid;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-white">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "w-full font-mono-address bg-black/30 border rounded-lg px-3 py-2.5 pr-9 text-sm",
            "placeholder:text-white/30",
            "focus:outline-none focus:ring-2 focus:ring-stellar/40 focus:ring-offset-0",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "transition-colors",
            showError ? "border-destructive focus:ring-destructive/50" : "border-white/10",
            isValid && touched ? "border-emerald-500/50" : ""
          )}
        />
        {touched && value && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
            {isValid ? (
              <CheckCircle className="h-4 w-4 text-emerald-500" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" />
            )}
          </div>
        )}
      </div>
      {showError && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          Not a valid Stellar address (must start with G)
        </p>
      )}
      {helpText && !showError && <p className="text-xs text-muted-foreground">{helpText}</p>}
    </div>
  );
}
