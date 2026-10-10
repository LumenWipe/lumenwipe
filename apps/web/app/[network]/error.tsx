"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, ExternalLink, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SE_EXPLORER_BASE, type Network } from "@/config/networks";
import { submissionClaim } from "@/lib/close-state";
import { useDemolishStore } from "@/store/demolish";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

function toNetwork(value: string | string[] | undefined): Network {
  return value === "mainnet" ? "mainnet" : "testnet";
}

export default function NetworkError({ error, reset }: ErrorProps) {
  const params = useParams<{ network?: string }>();
  const network = toNetwork(params?.network);
  const phase = useDemolishStore((s) => s.phase);
  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const sourceAddress = useDemolishStore((s) => s.sourceAddress);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error("[network] unhandled error:", error);
  }, [error]);

  const mayBeSent = submissionClaim(phase, executionPlan) === "may-be-sent";
  const home = `/${network}`;

  async function copyRef(): Promise<void> {
    try {
      await navigator.clipboard.writeText(error.digest ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const tryAgain = (
    <button
      onClick={reset}
      className={
        mayBeSent
          ? "inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
          : "inline-flex items-center gap-2 rounded-xl bg-stellar px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-stellar/90"
      }
    >
      <RotateCcw className="h-3.5 w-3.5" />
      Try again
    </button>
  );

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-5">
      <div className="w-full max-w-sm text-center space-y-5">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning/10">
          <AlertTriangle className="h-6 w-6 text-warning" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-white">Something went wrong</h2>
          <p className="text-sm text-white/60 leading-relaxed">
            {mayBeSent
              ? "An unexpected error occurred. Some transactions may already be confirmed. Check the account on the explorer before retrying. You can resume the close from the home page, which re-reads the account first."
              : "An unexpected error occurred. Nothing has been signed or sent."}
          </p>
          {error.digest && (
            <p className="mkt-mono flex items-center justify-center gap-1.5 pt-1 text-[0.7rem] text-white/60">
              ref: {error.digest}
              <button
                onClick={copyRef}
                aria-label="Copy error reference"
                className="rounded p-1 text-white/60 transition-colors hover:text-white"
              >
                <Copy className="h-3 w-3" />
              </button>
              {copied && <span role="status">Copied</span>}
            </p>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-3">
          {!mayBeSent && tryAgain}
          {mayBeSent && (
            <Link
              href={home}
              className="inline-flex items-center gap-2 rounded-xl bg-stellar px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-stellar/90"
            >
              Resume the close
            </Link>
          )}
          {mayBeSent && sourceAddress && (
            <a
              href={`${SE_EXPLORER_BASE[network]}/account/${sourceAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:border-white/20 hover:text-white"
            >
              View the account
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Link
            href={home}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Go home
          </Link>
          {mayBeSent && tryAgain}
        </div>
      </div>
    </div>
  );
}
