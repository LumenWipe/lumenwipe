"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { toUserMessage } from "@/lib/utils/user-error";
import type { AccountSigner } from "@/types/account";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

interface Props {
  signer: AccountSigner;
  disabled?: boolean;
  onSubmit: (signer: AccountSigner, xdr: string) => Promise<void>;
}

/**
 * Lets the user satisfy one pre-auth-tx signer by pasting the exact transaction they
 * pre-authorized in advance. A pre-auth-tx signer's key is the HASH of that one specific
 * transaction - it contributes weight only when that exact transaction is submitted, never by
 * signing anything now, so this is structurally different from every other signer type in the
 * app. This is also the one path where the transaction under review was never built or
 * verified by LumenWipe the way the rest of the flow's transactions are - the persistent
 * warning below is not dismissible, and is always shown whenever this input is rendered.
 */
export default function PreAuthTxInput({ signer, disabled, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(signer, value.trim());
      setSubmitted(true);
    } catch (err) {
      setError(toUserMessage(err, "execute"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-3">
      <p className="font-mono-address text-xs text-fg-muted">
        {shortAddr(signer.key)} <span className="text-fg-subtle">· weight {signer.weight}</span>
      </p>
      <p className="flex items-start gap-1.5 text-xs text-fg-muted">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-fg-subtle" />
        This is a pre-auth-tx signer - its key is the hash of one exact transaction you authorized
        in advance, not a wallet address. It contributes weight only by that exact transaction being
        submitted, not by signing anything now. If you already hold a transaction you pre-authorized
        for this close, paste it below.
      </p>
      <Callout
        tone="warning"
        announce={false}
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        className="gap-1.5 p-2.5 text-xs"
      >
        This transaction was not built or verified by LumenWipe the way the rest of this flow&apos;s
        transactions are. You are responsible for having reviewed its contents yourself before
        submitting it here.
      </Callout>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
          setSubmitted(false);
        }}
        placeholder="paste the pre-authorized transaction XDR"
        disabled={disabled || submitting || submitted}
        spellCheck={false}
        autoCorrect="off"
        rows={4}
        className={cn(
          "w-full font-mono-address bg-black/30 border rounded-lg px-3 py-2 text-xs",
          "placeholder:text-fg-subtle",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          error ? "border-danger" : "border-white/10"
        )}
      />
      <Button
        size="sm"
        type="button"
        onClick={submit}
        disabled={disabled || submitting || submitted || value.trim().length === 0}
        loading={submitting}
        className="self-start shrink-0"
      >
        {submitting ? "Submitting…" : "Submit pre-authorized transaction"}
      </Button>
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-danger-fg">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {submitted && !error && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle className="h-3.5 w-3.5 shrink-0" />
          Pre-authorized transaction submitted.
        </p>
      )}
    </Card>
  );
}
