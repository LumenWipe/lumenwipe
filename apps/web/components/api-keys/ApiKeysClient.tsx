"use client";

import { PollarProvider } from "@pollar/react";
import ApiKeysPanel, { API_DOCS_URL, QUICKSTART_URL } from "./ApiKeysPanel";
import PollarSignIn from "./PollarSignIn";

const POLLAR_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

export default function ApiKeysClient() {
  return (
    <div className="mx-auto max-w-3xl px-5 pb-24 pt-12 lg:px-8">
      <span className="mkt-eyebrow inline-flex items-center gap-2 text-accent/90">
        <span className="h-px w-6 bg-accent/50" />
        Developers
      </span>
      <h1 className="mkt-display mt-3 text-3xl font-bold text-white sm:text-4xl">API keys</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/65">
        Sign in with a Stellar wallet, create a key, and start calling the LumenWipe API or SDK
        right away. Your key is shown once when you create it, so store it somewhere safe. New here?
        Start with the{" "}
        <a className="underline" href={QUICKSTART_URL}>
          SDK quickstart
        </a>{" "}
        or the{" "}
        <a className="underline" href={API_DOCS_URL}>
          API reference
        </a>
        .
      </p>

      <div className="mt-8">
        {POLLAR_PUBLISHABLE_KEY ? (
          <PollarProvider client={{ apiKey: POLLAR_PUBLISHABLE_KEY }}>
            <ApiKeysPanel pollar={PollarSignIn} />
          </PollarProvider>
        ) : (
          <ApiKeysPanel />
        )}
      </div>
    </div>
  );
}
