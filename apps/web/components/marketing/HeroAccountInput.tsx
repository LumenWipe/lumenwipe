"use client";

import { useCallback, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { AddressField } from "@/components/ui/address-field";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { HERO } from "@/lib/i18n/messages/hero";
import { addressErrorMessage } from "@/lib/utils/validation";

// Loaded only when a visitor asks for an estimate, so the landing page's first load carries none
// of it.
const RecoveryEstimate = dynamic(() => import("@/components/marketing/RecoveryEstimate"), {
  ssr: false,
});

export default function HeroAccountInput({ locale = SITE_LOCALE }: { locale?: Locale }) {
  const T = HERO[locale].input;
  const refusalOf = (address: string): string | null =>
    address ? addressErrorMessage(address, locale) : T.empty;
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The address being estimated, held in memory only, and a count so asking again reads again.
  const [estimate, setEstimate] = useState<{ address: string; request: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function analyze(target: string) {
    router.push(`/mainnet/analyze?source=${encodeURIComponent(target)}`);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const refusal = refusalOf(address);
    setError(refusal);
    if (!refusal) analyze(address);
  }

  function handleEstimate() {
    const refusal = refusalOf(address);
    setError(refusal);
    if (refusal) return;
    setEstimate((prev) => ({ address, request: (prev?.request ?? 0) + 1 }));
  }

  const announce = useCallback((text: string) => setAnnouncement(text), []);

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form onSubmit={handleSubmit}>
        <AddressField
          label={T.label}
          hideLabel
          value={address}
          onChange={(next) => {
            setAddress(next);
            if (error) setError(null);
            // An estimate speaks for the address it read, never for an edited one.
            if (estimate && next !== estimate.address) setEstimate(null);
          }}
          error={error}
          locale={locale}
          placeholder={T.placeholder}
          groupClassName="flex-col items-stretch sm:flex-row sm:items-center rounded-2xl border border-line-strong bg-white/[0.04] p-2 transition-colors has-[input[aria-invalid=true]]:border-danger has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus"
          inputClassName="border-0 bg-transparent px-2 sm:px-0 sm:pr-2 text-body-sm text-white focus-visible:outline-none"
          leading={
            <Search
              aria-hidden
              className="ml-2 hidden h-4 w-4 shrink-0 text-fg-disabled sm:block"
            />
          }
          trailing={
            <Button type="submit" className="w-full shrink-0 sm:w-auto">
              {T.analyze}
            </Button>
          }
        />
      </form>

      <p className="mt-2.5 text-center text-xs text-fg-subtle">
        {T.reassurance(
          <button
            type="button"
            onClick={handleEstimate}
            className="font-semibold text-white/80 underline underline-offset-2 hover:text-white"
          >
            {T.estimate}
          </button>
        )}
      </p>

      <p className="mt-2 text-center text-xs text-fg-muted">
        {T.playground(
          <Link
            href="/playground"
            className="font-semibold text-accent underline underline-offset-2"
          >
            {T.playgroundLink}
          </Link>
        )}
      </p>

      {/* Present before any estimate, so its content changes are announced. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {estimate && (
        <RecoveryEstimate
          key={estimate.request}
          address={estimate.address}
          network="mainnet"
          locale={locale}
          onAnnounce={announce}
          onContinue={() => analyze(estimate.address)}
        />
      )}
    </div>
  );
}
