"use client";

import { useEffect, useId, useState } from "react";
import { Check, ClipboardCopy, Code2 } from "lucide-react";
import { usePlaygroundStore, type PlaygroundPhase } from "@/store/playground";

const SHOWN_IN: ReadonlySet<PlaygroundPhase> = new Set([
  "DIRTY",
  "DEMOLISHING",
  "COMPLETE",
  "ERROR",
]);

export default function SdkSnippetPanel() {
  const phase = usePlaygroundStore((s) => s.phase);
  const snippet = usePlaygroundStore((s) => s.sdkSnippet);
  const [copied, setCopied] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!snippet || !SHOWN_IN.has(phase)) return null;
  const closed = phase === "COMPLETE";

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  }

  return (
    <section aria-labelledby={titleId} className="mkt-panel relative mt-6 rounded-lg p-4 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="mkt-eyebrow flex items-center gap-2 text-white/50">
            <Code2 className="h-3.5 w-3.5 text-stellar" />
            {closed ? "This close with the SDK" : "The same close in code"}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-white/50">
            {closed
              ? "What an integrator writes to run the close you just watched"
              : "What an integrator writes to run the close this demo is about to"}{" "}
            with <span className="mkt-mono">@lumenwipe/sdk</span>, checking every transaction with{" "}
            <span className="mkt-mono">@lumenwipe/verify</span> before signing it. Your API key and
            signing key come from the environment.
          </p>
        </div>
        <button
          type="button"
          onClick={() => handleCopy(snippet)}
          aria-label="Copy the SDK code"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/5"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-stellar" />
          ) : (
            <ClipboardCopy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <span role="status" className="sr-only">
          {copied ? "Copied to the clipboard" : ""}
        </span>
      </div>
      <pre
        tabIndex={0}
        aria-label="SDK code for this close"
        className="max-h-96 overflow-auto rounded-md border border-white/10 bg-white/[0.03] p-3 mkt-mono text-[11px] leading-relaxed text-white/75"
      >
        <code>{snippet}</code>
      </pre>
    </section>
  );
}
