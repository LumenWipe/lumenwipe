"use client";

import { PollarProvider } from "@pollar/react";
import ApiKeysPanel from "./ApiKeysPanel";

const POLLAR_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

export default function ApiKeysClient() {
  return (
    <div className="mx-auto max-w-3xl px-5 pb-24 pt-12 lg:px-8">
      <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
        <span className="h-px w-6 bg-stellar/50" />
        Developers
      </span>
      <h1 className="mkt-display mt-3 text-3xl font-bold text-white sm:text-4xl">API keys</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/65">
        Sign in, create a key, and start calling the LumenWipe API or SDK right away. Your key is
        shown once when you create it, so store it somewhere safe.
      </p>

      <div className="mt-8">
        {POLLAR_PUBLISHABLE_KEY ? (
          <PollarProvider client={{ apiKey: POLLAR_PUBLISHABLE_KEY }}>
            <ApiKeysPanel />
          </PollarProvider>
        ) : (
          <p role="alert" className="rounded-xl border border-warning/30 bg-warning/5 p-5 text-sm">
            Sign-in is not available right now. Please try again later.
          </p>
        )}
      </div>
    </div>
  );
}
