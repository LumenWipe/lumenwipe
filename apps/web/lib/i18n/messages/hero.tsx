import type { ReactNode } from "react";
import { plural, pluralForm } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const en = {
  console: {
    account: "account · GABC…WXYZ",
    scanning: "scanning",
    complete: "complete",
    steps: {
      signers: "Normalize signers",
      data: "Clear data entries",
      offers: "Cancel open offers",
      convert: "Convert assets to XLM",
      trustlines: "Remove trustlines",
      merge: "Merge to destination",
    },
    recoverable: "Recoverable reserve",
    progress: (done: number, total: number, xlm: string): ReactNode => (
      <>
        Example account · {done} of {total} steps · {xlm} XLM total
      </>
    ),
  },
  input: {
    label: "Stellar account address",
    placeholder: "Paste a Stellar account address - G…",
    empty: "Enter a Stellar account address.",
    analyze: "Analyze account",
    reassurance: (estimate: ReactNode): ReactNode => (
      <>
        {"Analyzes on mainnet · read-only until you sign · no account needed ·"} {estimate}
      </>
    ),
    estimate: "Estimate recovery",
    playground: (link: ReactNode): ReactNode => (
      <>
        {"Not ready yet?"} {link} {"with a throwaway testnet account, no wallet needed."}
      </>
    ),
    playgroundLink: "Try the playground",
  },
  estimate: {
    heading: "Recovery estimate",
    caveat: "Estimate, not a promise: fees and market quotes change",
    reading: "Reading the account…",
    readingAnnouncement: "Reading the account.",
    about: (xlm: string): string => `About ${xlm} XLM`,
    range: (low: string, high: string): string => `${low} to ${high} XLM`,
    blockers: (n: number): string =>
      n === 0
        ? "No items found that would block a close."
        : `${count(n, "item", "items")} would block a close until resolved.`,
    assumptions: {
      low: "Low: the XLM balance less estimated network fees, with no conversions.",
      high: "High: adds the minimum quoted for converting other assets to XLM, and any XLM claimable balances. Quotes move with the market.",
      exchangeFee: "Fees include the extra network fee an exchange destination needs.",
      unquoted: (n: number): string =>
        `${count(n, "asset", "assets")} had no quote and count as zero.`,
      unconvertible: (n: number): string =>
        `${count(n, "asset has", "assets have")} no route to XLM and ${n === 1 ? "is" : "are"} not counted.`,
      defiExits: "XLM paid out by exiting DeFi positions is not counted.",
    },
    announcement: (range: string, blockers: string, caveat: string): string =>
      `Estimated recovery: ${range}. ${blockers} ${caveat}.`,
    readAt: (time: ReactNode): ReactNode => (
      <>
        Read at {time} {"from the public ledger. No wallet, no signing."}
      </>
    ),
    continue: "Continue to close",
    errors: {
      invalid: "Enter a valid Stellar account address.",
      missing:
        "No account with this address exists on this network, so there is nothing to recover.",
      limited: "Too many estimates from this connection today. You can still continue to close.",
      unreadable:
        "We couldn't read this account right now, so there is no estimate. Try again in a moment, or continue to close.",
    },
  },
};

export type HeroCopy = typeof en;

const form = (n: number, one: string, other: string): string => pluralForm("es", n, { one, other });

const es: HeroCopy = {
  console: {
    account: "cuenta · GABC…WXYZ",
    scanning: "analizando",
    complete: "completo",
    steps: {
      signers: "Normalizar signers",
      data: "Borrar data entries",
      offers: "Cancelar offers abiertas",
      convert: "Convertir activos a XLM",
      trustlines: "Quitar trustlines",
      merge: "Hacer el merge al destino",
    },
    recoverable: "Reserva recuperable",
    progress: (done: number, total: number, xlm: string): ReactNode => (
      <>
        Cuenta de ejemplo · {done} de {total} pasos · {xlm} XLM en total
      </>
    ),
  },
  input: {
    label: "Dirección de cuenta de Stellar",
    placeholder: "Pega una dirección de cuenta de Stellar - G…",
    empty: "Ingresa una dirección de cuenta de Stellar.",
    analyze: "Analizar la cuenta",
    reassurance: (estimate: ReactNode): ReactNode => (
      <>
        {"Analiza en mainnet · solo lectura hasta que firmes · no necesitas una cuenta ·"}{" "}
        {estimate}
      </>
    ),
    estimate: "Estimar lo recuperable",
    playground: (link: ReactNode): ReactNode => (
      <>
        {"¿Todavía no estás listo?"} {link} {"con una cuenta desechable de testnet, sin billetera."}
      </>
    ),
    playgroundLink: "Prueba el playground",
  },
  estimate: {
    heading: "Estimación de lo recuperable",
    caveat:
      "Es una estimación, no una promesa: las comisiones y las cotizaciones del mercado cambian",
    reading: "Leyendo la cuenta…",
    readingAnnouncement: "Leyendo la cuenta.",
    about: (xlm: string): string => `Cerca de ${xlm} XLM`,
    range: (low: string, high: string): string => `De ${low} a ${high} XLM`,
    blockers: (n: number): string =>
      n === 0
        ? "No se encontró ningún elemento que bloquee el cierre."
        : `${plural("es", n, { one: "elemento", other: "elementos" })} ${form(n, "bloquearía", "bloquearían")} el cierre hasta que se ${form(n, "resuelva", "resuelvan")}.`,
    assumptions: {
      low: "Mínimo: el saldo de XLM menos las comisiones de red estimadas, sin conversiones.",
      high: "Máximo: suma el mínimo cotizado por convertir otros activos a XLM, y cualquier claimable balance (saldo reclamable) en XLM. Las cotizaciones cambian con el mercado.",
      exchangeFee:
        "Las comisiones incluyen la comisión de red adicional que necesita un destino en un exchange.",
      unquoted: (n: number): string =>
        `${plural("es", n, { one: "activo", other: "activos" })} no ${form(n, "tuvo", "tuvieron")} cotización y ${form(n, "cuenta", "cuentan")} como cero.`,
      unconvertible: (n: number): string =>
        `${plural("es", n, { one: "activo", other: "activos" })} no ${form(n, "tiene", "tienen")} ruta a XLM y no se ${form(n, "cuenta", "cuentan")}.`,
      defiExits: "No se cuenta el XLM que se obtiene al salir de posiciones de DeFi.",
    },
    announcement: (range: string, blockers: string, caveat: string): string =>
      `Recuperación estimada: ${range}. ${blockers} ${caveat}.`,
    readAt: (time: ReactNode): ReactNode => (
      <>
        Leído a las {time} {"del ledger público. Sin billetera y sin firmar."}
      </>
    ),
    continue: "Continuar con el cierre",
    errors: {
      invalid: "Ingresa una dirección de cuenta de Stellar válida.",
      missing:
        "No existe ninguna cuenta con esta dirección en esta red, así que no hay nada que recuperar.",
      limited:
        "Hoy hubo demasiadas estimaciones desde esta conexión. Aun así puedes continuar con el cierre.",
      unreadable:
        "No pudimos leer esta cuenta en este momento, así que no hay estimación. Inténtalo de nuevo en un momento o continúa con el cierre.",
    },
  },
};

export const HERO: Record<Locale, HeroCopy> = { en, es };
