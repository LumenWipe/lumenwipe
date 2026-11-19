import type { ReactNode } from "react";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  description: (exchangeLive: boolean): string =>
    `LumenWipe closes a Stellar account end to end and recovers the XLM locked in its reserves. Unwind trustlines, offers, data entries and Soroban DeFi positions, then merge out to ${exchangeLive ? "your wallet or exchange" : "your wallet"}. Non-custodial, open source.`,
  hero: {
    label: "Recover your locked XLM",
    headline: (accent: (text: string) => ReactNode): ReactNode => (
      <>Close the account. Keep the {accent("lumens.")}</>
    ),
    openApp: "Open the app",
    howItWorks: "See how it works",
  },
  stats: {
    asOf: (date: string, source: ReactNode): ReactNode => (
      <>
        {"As of "}
        {date}
        {" ·"} {source}
      </>
    ),
    source: "Source: ",
    registry: "From the contract registry",
  },
  problem: {
    eyebrow: "The problem",
    heading: "Your lumens are locked, and the exit is a maze.",
    body: "Every Stellar account holds XLM in reserve: 1 XLM for the account, plus 0.5 for every trustline, offer, data entry and signer. That reserve is only recoverable by closing the account, and closing one cleanly is harder than it sounds.",
    reserve: "Locked reserve",
    example: "Example account",
    total: "Total locked",
    truths: {
      reverts: {
        title: "One mistake and it all reverts",
        body: "A single leftover entry makes the final merge fail. Every offer, position, asset and entry must clear in the right order first.",
      },
      exchanges: {
        title: "Exchanges can't merge",
        body: (minimum: number): string =>
          `No major exchange accepts an account merge as a deposit. Pay your XLM out to an exchange instead and the ${minimum} XLM minimum stays locked in the account.`,
      },
      defi: {
        title: "DeFi positions hide outside the account",
        body: "A Blend loan, Aquarius liquidity or a Soroswap position lives in the protocol's contract. Merge the account while one is open and the funds stay stranded there, so each has to be exited through its own contract first.",
      },
    },
  },
  capabilities: {
    eyebrow: "What you get",
    heading: "Built for the messy reality of real accounts.",
    liveExits: "Protocol exits live on mainnet",
  },
  faq: {
    stillCurious: (docs: ReactNode): ReactNode => (
      <>
        {"Still curious?"} {docs}.
      </>
    ),
    docs: "Read the full documentation",
  },
  cta: {
    heading: "Reclaim the XLM that's been sitting locked.",
    body: "Try the entire flow on testnet with no funds at risk, then switch to mainnet for the real close.",
    openApp: "Open the app",
    testnet: "Try on testnet",
    noSignup: "No signup",
    signedInBrowser: "Signed in your browser",
    openSource: "Open source",
  },
};

export type LandingCopy = typeof en;

const es: LandingCopy = {
  description: (exchangeLive: boolean): string =>
    `LumenWipe cierra una cuenta de Stellar de principio a fin y recupera el XLM bloqueado en sus reservas. Deshace trustlines, offers, data entries y posiciones de DeFi en Soroban, y luego envía el saldo con un merge a ${exchangeLive ? "tu billetera o exchange" : "tu billetera"}. No custodial, de código abierto.`,
  hero: {
    label: "Recupera tu XLM bloqueado",
    headline: (accent: (text: string) => ReactNode): ReactNode => (
      <>Cierra la cuenta. Quédate con los {accent("lumens.")}</>
    ),
    openApp: "Abrir la app",
    howItWorks: "Ver cómo funciona",
  },
  stats: {
    asOf: (date: string, source: ReactNode): ReactNode => (
      <>
        {"Dato de "}
        {date}
        {" ·"} {source}
      </>
    ),
    source: "Fuente: ",
    registry: "Del registro de contratos",
  },
  problem: {
    eyebrow: "El problema",
    heading: "Tus lumens están bloqueados, y la salida es un laberinto.",
    body: "Toda cuenta de Stellar mantiene XLM en reserva: 1 XLM por la cuenta, más 0.5 por cada trustline, offer, data entry y signer. Esa reserva solo se recupera cerrando la cuenta, y cerrarla de forma limpia es más difícil de lo que parece.",
    reserve: "Reserva bloqueada",
    example: "Cuenta de ejemplo",
    total: "Total bloqueado",
    truths: {
      reverts: {
        title: "Un solo error y todo se revierte",
        body: "Un solo elemento sobrante hace fallar el merge final. Cada offer, posición, activo y elemento tiene que resolverse antes, en el orden correcto.",
      },
      exchanges: {
        title: "Los exchanges no aceptan un merge",
        body: (minimum: number): string =>
          `Ningún exchange importante acepta un merge de cuenta como depósito. Si en su lugar envías tu XLM a un exchange con un pago, el mínimo de ${formatNumber("es", minimum)} XLM queda bloqueado en la cuenta.`,
      },
      defi: {
        title: "Las posiciones de DeFi se esconden fuera de la cuenta",
        body: "Un préstamo en Blend, la liquidez en Aquarius o una posición en Soroswap viven en el contrato del protocolo. Si haces el merge de la cuenta con una de ellas abierta, los fondos quedan varados allí, así que primero hay que salir de cada una a través de su propio contrato.",
      },
    },
  },
  capabilities: {
    eyebrow: "Lo que obtienes",
    heading: "Hecho para la realidad desordenada de las cuentas reales.",
    liveExits: "Salidas de protocolos disponibles en mainnet",
  },
  faq: {
    stillCurious: (docs: ReactNode): ReactNode => (
      <>
        {"¿Todavía tienes dudas?"} {docs}.
      </>
    ),
    docs: "Lee la documentación completa",
  },
  cta: {
    heading: "Recupera el XLM que lleva tiempo bloqueado.",
    body: "Prueba todo el flujo en testnet sin arriesgar fondos y luego cambia a mainnet para el cierre real.",
    openApp: "Abrir la app",
    testnet: "Probar en testnet",
    noSignup: "Sin registro",
    signedInBrowser: "Firmado en tu navegador",
    openSource: "Código abierto",
  },
};

export const LANDING: Record<Locale, LandingCopy> = { en, es };
