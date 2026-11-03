"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { AddressField } from "@/components/ui/address-field";
import { addressErrorMessage } from "@/lib/utils/validation";

export default function HeroAccountInput() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const refusal = address ? addressErrorMessage(address) : "Enter a Stellar account address.";
    setError(refusal);
    if (!refusal) router.push(`/mainnet/analyze?source=${encodeURIComponent(address)}`);
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form onSubmit={handleSubmit}>
        <AddressField
          label="Stellar account address"
          hideLabel
          value={address}
          onChange={(next) => {
            setAddress(next);
            if (error) setError(null);
          }}
          error={error}
          placeholder="Paste a Stellar account address - G…"
          groupClassName="rounded-2xl border border-line-strong bg-white/[0.04] p-2 transition-colors has-[input[aria-invalid=true]]:border-danger has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus"
          inputClassName="border-0 bg-transparent px-0 pr-2 text-[0.8rem] text-white focus-visible:outline-none"
          leading={<Search className="ml-2 h-4 w-4 shrink-0 text-fg-disabled" />}
          trailing={
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-value px-5 py-2.5 text-sm font-semibold text-value-fg transition-all hover:bg-value/90 hover:shadow-[0_8px_24px_-8px_hsl(var(--value)/0.6)]"
            >
              Analyze account
            </button>
          }
        />
      </form>

      <p className="mt-2.5 text-center text-xs text-fg-subtle">
        Analyzes on mainnet · read-only until you sign · no account needed
      </p>
    </div>
  );
}
