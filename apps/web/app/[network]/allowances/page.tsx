"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, ShieldCheck, Search } from "lucide-react";
import type { Network } from "@/config/networks";
import type { Allowance, AllowancesResult } from "@/types/allowance";
import { useDemolishStore } from "@/store/demolish";
import { isValidGAddress } from "@/lib/utils/validation";
import { apiErrorMessage } from "@/lib/api/error-body";
import AllowanceRow from "@/components/allowances/AllowanceRow";
import RevokeAllowanceModal from "@/components/allowances/RevokeAllowanceModal";

/**
 * The allowance inspector (#163, architecture.md §12): a standalone security utility, reachable
 * on its own without starting a close. Independent of `useDemolishStore`'s close-flow state
 * beyond an optional prefill - nothing here writes to it.
 */
export default function AllowancesPage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const storedSource = useDemolishStore((s) => s.sourceAddress);

  const [input, setInput] = useState(searchParams.get("address") ?? storedSource ?? "");
  const [address, setAddress] = useState<string | null>(null);
  const [result, setResult] = useState<AllowancesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Allowance | null>(null);

  const lookup = useCallback(
    async (addr: string) => {
      if (!isValidGAddress(addr)) {
        setError("Enter a valid Stellar account address (G...).");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/${network}/allowances/${addr}`);
        const data = await res.json();
        if (!res.ok) {
          setError(apiErrorMessage(data, "Failed to read allowances for this account."));
          setResult(null);
          return;
        }
        setResult(data as AllowancesResult);
        setAddress(addr);
        router.replace(`/${network}/allowances?address=${encodeURIComponent(addr)}`);
      } catch {
        setError("Failed to read allowances. Please check your connection and try again.");
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [network, router]
  );

  // Auto-run once for a URL- or store-prefilled address, so a link (or arriving from the close
  // flow's account entry) lands on results directly instead of an empty form.
  useEffect(() => {
    const initial = searchParams.get("address") ?? storedSource;
    if (initial && isValidGAddress(initial)) void lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRevoked(revoked: Allowance) {
    setResult((prev) =>
      prev
        ? {
            ...prev,
            allowances: prev.allowances.filter(
              (a) => !(a.token === revoked.token && a.spender === revoked.spender)
            ),
          }
        : prev
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Link
          href={`/${network}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="mkt-display text-xl font-bold text-white">Allowance inspector</h1>
      </div>

      <div className="mkt-panel rounded-2xl p-5 mb-6">
        <p className="text-sm text-white/60 leading-relaxed mb-4">
          Every live token approval a Stellar account has granted to a contract - a DeFi protocol,
          or anywhere else. Nothing here is part of closing an account; revoking an allowance only
          protects your balance from that spender, it never moves your funds.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(input.trim());
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="G... (the account to inspect)"
            spellCheck={false}
            autoComplete="off"
            className="w-full flex-1 font-mono-address bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-stellar/40"
          />
          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-1.5 bg-stellar text-black font-semibold py-2.5 px-4 rounded-lg hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Inspect
          </button>
        </form>
      </div>

      {error && (
        <div className="mkt-panel border-destructive/30 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}

      {result && address && (
        <div className="space-y-3">
          {result.allowances.length === 0 ? (
            <div className="mkt-panel rounded-2xl p-8 text-center">
              <ShieldCheck className="h-8 w-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-white">No outstanding allowances</p>
              <p className="mt-1 text-xs text-white/45">
                This account has not approved any spender that is currently live.
              </p>
            </div>
          ) : (
            result.allowances.map((a) => (
              <AllowanceRow key={`${a.token}:${a.spender}`} allowance={a} onRevoke={setRevoking} />
            ))
          )}

          {result.warnings.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-white/40">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {result.warnings.map((w) => w.message).join(" ")}
            </p>
          )}
        </div>
      )}

      {revoking && address && (
        <RevokeAllowanceModal
          network={network}
          owner={address}
          allowance={revoking}
          onClose={() => setRevoking(null)}
          // Deliberately does not also close the modal: it shows its own "Allowance
          // revoked" confirmation and closes itself (via onClose) when the user clicks
          // Done, so the success state is actually seen rather than flashing by.
          onRevoked={handleRevoked}
        />
      )}
    </div>
  );
}
