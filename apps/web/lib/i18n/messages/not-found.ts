import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "404 - Page Not Found",
    description: "This page doesn't exist on the ledger.",
  },
  eyebrow: "ledger lookup · error_code: 404",
  consoleTitle: "lumenwipe · account-lookup",
  command: "lw analyze --network mainnet ",
  commandTarget: "this-page",
  steps: {
    route: "Resolving route",
    ledger: "Querying ledger state",
    account: "Account found",
  },
  failure: " - account_not_found",
  stats: {
    subentries: "Subentries",
    balance: "XLM balance",
    statusLabel: "Status",
    merged: "MERGED",
  },
  infoLabel: "info ",
  info: "This account was merged out. Nothing remains on the ledger.",
  title: ["This page has", "been closed."],
  lede: [
    "No trustlines. No balance. No subentries.",
    "Looks like this route was already merged out.",
  ],
  home: "Back to home",
  openApp: "Open the app",
  nextLabel: "Where to go next",
  next: {
    guides: "Guides",
    howItWorks: "How it works",
    playground: "Try the playground",
  },
  followedLink: "Followed a link here?",
  reportLink: "Report a broken link",
};

export type NotFoundCopy = typeof en;

export const NOT_FOUND: Record<Locale, NotFoundCopy> = { en, es: en };
