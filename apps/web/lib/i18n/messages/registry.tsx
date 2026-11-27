import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "Exchange registry",
    description:
      "The exchanges LumenWipe recognizes, the memo rule each one enforces, which DeFi protocols it can exit today, and when each list was last checked.",
  },
  eyebrow: "Registry",
  heading: "What LumenWipe treats as an exchange.",
  intro:
    "A close into an exchange needs the memo type that exchange enforces, and most exchanges need the balance passed on through the shared relay account. This page lists the exchanges the app recognizes, the rule it applies to each, and which DeFi protocols it can exit today, each with the date it was last checked.",
  notDeposit:
    "The addresses below are the ones the app recognizes, not addresses to send to. Always take your deposit address and memo from your exchange.",
  exchanges: "Exchanges and memo rules",
  source: {
    reading: "Reading the API's copy. Shown meanwhile: the copy shipped with this site.",
    failed: "The API's copy could not be read. Shown: the copy shipped with this site.",
    served: "Shown: the API's copy, read when this page loaded.",
  },
  dates: (lastChecked: ReactNode, reliedOn: ReactNode): ReactNode => (
    <>
      {"Last checked "}
      {lastChecked}
      {" · relied on until"} {reliedOn}
    </>
  ),
  current: "Current.",
  exchangesExpired: (validUntil: string): string =>
    `This list is past ${validUntil}, the last day it is relied on, so it is not current. The app refuses exchange closes until it is checked again.`,
  unsigned:
    "The API's copy is not signed, so it can only make a rule stricter. It can add an exchange, but a close passes through the relay account only for an exchange listed in the copy shipped with this site.",
  signed: (sequence: number): string =>
    `The API's copy is signed by the maintainers (sequence ${sequence}) and the signature was checked in this browser, so an exchange it adds can use the relay account. A signed copy can only add exchanges.`,
  memoRequired: (memoType: string): string => `${memoType} memo required`,
  noMemo: "No memo",
  throughRelay: "Through the relay account",
  relayUnavailable: "Needs the relay account, which this app version cannot use for it",
  mergedDirectly: "Merged directly",
  testnetOnly: " · Testnet only",
  added: "Added by the API's copy.",
  disputed:
    "The API's copy gives another memo type. Closes into this address are refused until the two copies agree.",
  protocols: "DeFi protocol exits",
  protocolsExpired: (validUntil: string): string =>
    `The protocol contract list is past ${validUntil}, the last day it is relied on, so these statuses are not current. The app refuses exits through a registered contract until it is checked again.`,
  protocolsCaption: "DeFi protocols and whether the app can exit them",
  protocolColumn: "Protocol",
  statusColumn: "Exit status",
};

export type RegistryCopy = typeof en;

export const REGISTRY: Record<Locale, RegistryCopy> = { en, es: en };
