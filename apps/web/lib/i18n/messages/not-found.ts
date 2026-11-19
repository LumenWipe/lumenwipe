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

const es: NotFoundCopy = {
  metadata: {
    title: "404 - Página no encontrada",
    description: "Esta página no existe en el ledger.",
  },
  eyebrow: "consulta al ledger · error_code: 404",
  consoleTitle: "lumenwipe · account-lookup",
  command: "lw analyze --network mainnet ",
  commandTarget: "esta-pagina",
  steps: {
    route: "Resolviendo la ruta",
    ledger: "Consultando el estado del ledger",
    account: "Cuenta encontrada",
  },
  failure: " - account_not_found",
  stats: {
    subentries: "Elementos",
    balance: "Saldo en XLM",
    statusLabel: "Estado",
    merged: "CERRADA",
  },
  infoLabel: "info ",
  info: "Esta cuenta ya se cerró. No queda nada en el ledger.",
  title: ["Esta página", "ya se cerró."],
  lede: ["Sin activos. Sin saldo. Sin elementos en reserva.", "Parece que esta ruta ya se cerró."],
  home: "Volver al inicio",
  openApp: "Abrir la app",
  nextLabel: "Adónde ir ahora",
  next: {
    guides: "Guías",
    howItWorks: "Cómo funciona",
    playground: "Probar el playground",
  },
  followedLink: "¿Llegaste aquí desde un enlace?",
  reportLink: "Reporta un enlace roto",
};

export const NOT_FOUND: Record<Locale, NotFoundCopy> = { en, es };
