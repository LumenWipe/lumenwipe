"use client";

import { useCallback, useState } from "react";

type Phase = "idle" | "messing" | "messed" | "demolishing" | "done" | "error";

interface SessionInfo {
  sessionId: string;
  demoPublic: string;
  messPlan: { id: string; label: string }[];
}

export default function PlaygroundClient() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    setPhase("messing");
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "standard" }),
      });
      if (!res.ok) throw new Error("Could not start a session.");
      const data = (await res.json()) as SessionInfo;
      setSession(data);

      for (const step of data.messPlan) {
        const stepRes = await fetch(`/api/session/${data.sessionId}/mess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stepId: step.id }),
        });
        if (!stepRes.ok) throw new Error(`Mess step ${step.id} failed.`);
        setCompletedSteps((prev) => [...prev, step.id]);
      }
      setPhase("messed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("error");
    }
  }, []);

  const demolish = useCallback(async () => {
    if (!session) return;
    setPhase("demolishing");
    setError(null);
    try {
      const res = await fetch(`/api/session/${session.sessionId}/demolish`, { method: "POST" });
      if (!res.ok) throw new Error("The close did not complete.");
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("error");
    }
  }, [session]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <p className="mkt-eyebrow mb-3 text-stellar">Testnet playground</p>
      <h1 className="mkt-display text-4xl text-white sm:text-5xl">
        Trash an account. Then watch it vanish.
      </h1>
      <p className="mt-4 text-base leading-relaxed text-white/85">
        Everything here happens on the Stellar testnet with a throwaway demo account - no wallet,
        no risk, real transactions.
      </p>

      {phase === "idle" && (
        <button
          onClick={start}
          className="mt-8 rounded-md bg-stellar px-6 py-3 text-sm font-medium text-black"
        >
          Start
        </button>
      )}

      {session && (
        <div className="mt-8 text-left">
          <p className="text-sm text-white/60">Demo account: {session.demoPublic}</p>
          <ul className="mt-4 space-y-1">
            {session.messPlan.map((step) => (
              <li key={step.id} className="text-sm text-white/80">
                {completedSteps.includes(step.id) ? "✓" : "…"} {step.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase === "messed" && (
        <button
          onClick={demolish}
          className="mt-8 rounded-md bg-stellar px-6 py-3 text-sm font-medium text-black"
        >
          Demolish it
        </button>
      )}

      {phase === "demolishing" && <p className="mt-8 text-white/70">Closing the account…</p>}
      {phase === "done" && (
        <p className="mt-8 text-white/85">Done - the account no longer exists on testnet.</p>
      )}
      {error && <p className="mt-4 text-red-400">{error}</p>}
    </div>
  );
}
