import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "Security",
    description:
      "How LumenWipe keeps your key in your browser, what its API builds, what your browser checks before you sign, and the two server keys and what each may sign.",
  },
  eyebrow: "Trust model",
  heading: "The trust boundary is your browser.",
  lede: (keyStatement: string, checkStatement: string): ReactNode => (
    <>
      {
        "LumenWipe builds transactions that drain accounts irreversibly, so the design starts from that fact. "
      }
      {keyStatement} {checkStatement}
    </>
  ),
  openSource: (verifyLink: ReactNode, registryLink: ReactNode): ReactNode => (
    <>
      {"The check is open source:"} {verifyLink}
      {
        ". The exchanges and memo rules it checks against, and the protocols it can exit, are listed in the"
      }{" "}
      {registryLink}.
    </>
  ),
  verifyLink: "read verify.ts on GitHub",
  registryLink: "exchange registry",
  layers: {
    browser: {
      label: "Your browser",
      sub: "Wallet · transaction check · signing · session",
      note: "your key stays here",
    },
    api: {
      label: "LumenWipe API",
      sub: "Account reads · DeFi adapters · builds unsigned transactions · relay and fee-sponsor keys",
      note: "never holds your key",
    },
    network: {
      label: "Stellar network & data",
      sub: "Stellar RPC · Horizon · Soroswap API",
      note: "read · simulate · submit",
    },
  },
  keyStays: "Your key stays in your browser",
  guarantees: {
    key: {
      title: "Private key",
      body: "Never transmitted. It stays in your wallet, or in memory only for the duration of the close, never persisted and cleared when you finish, abort, or navigate away.",
    },
    steps: {
      title: "Every destructive step",
      body: "Reviewed as raw XDR and explicitly confirmed before signing. The full plan is shown up front and each step is simulated first.",
    },
    memo: {
      title: "Exchange memo",
      body: "Required and validated against a registry of known exchanges that enforces the memo type; a missing memo blocks submission so deposits don't go missing.",
    },
    api: {
      title: "API compromise",
      body: "It holds no key that can sign for your account, and your browser checks the operations and destination of every transaction it builds before you sign. Figures your browser can only take from the API's own reads, such as a conversion quote, are shown for you to accept.",
    },
    csp: {
      title: "Strict CSP",
      body: "No inline scripts, no unsafe-eval. Dependencies are lockfile-pinned and audited in CI; the transaction builder is a pure, unit-tested module with zero network side effects.",
    },
  },
  serverKeysHeading: "Keys on the server",
  openApp: "Open the app",
  securityModel: "Read the security model",
};

export type SecurityCopy = typeof en;

export const SECURITY: Record<Locale, SecurityCopy> = { en };
