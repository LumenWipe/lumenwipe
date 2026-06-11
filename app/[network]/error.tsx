"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function NetworkError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[network] unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-5">
      <div className="w-full max-w-sm text-center space-y-5">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning/10">
          <AlertTriangle className="h-6 w-6 text-warning" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-white">Something went wrong</h2>
          <p className="text-sm text-white/45 leading-relaxed">
            {error.message ||
              "An unexpected error occurred. Your funds are safe — no transaction was submitted."}
          </p>
          {error.digest && (
            <p className="mkt-mono text-[0.65rem] text-white/20 pt-1">ref: {error.digest}</p>
          )}
        </div>

        <div className="flex justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl bg-stellar px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-stellar/90"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
