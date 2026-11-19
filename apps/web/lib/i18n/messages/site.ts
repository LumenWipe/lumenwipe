import { formatList, formatNumber, plural } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import type { FeatureId, SiteStatus } from "@/lib/site/status";

export interface FeatureCopy {
  title: string;
  /** How a sentence names it, lower case. */
  noun: string;
  summary: string;
  linkLabel?: string;
}

export interface ServerKeyCopy {
  name: string;
  statement: string;
}

const STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Live",
  "testnet-only": "Testnet only",
  soon: "Soon",
};

const FEATURES: Record<FeatureId, FeatureCopy> = {
  "classic-close": {
    title: "Classic account close",
    noun: "classic closes",
    summary:
      "Removes signers, data entries, offers and trustlines, converts or returns leftover assets, and merges the account into a wallet you choose.",
  },
  "defi-exits": {
    title: "Soroban DeFi exits",
    noun: "Soroban DeFi exits",
    summary:
      "Detects positions through OctoPos and exits each one with its own protocol adapter, repaying loans, withdrawing liquidity and unstaking, before the trustline is removed.",
  },
  "exchange-close": {
    title: "Exchange-compatible close",
    noun: "exchange closes",
    summary:
      "A shared relay account receives the merge and pays the balance on to an exchange deposit address, with the memo the exchange requires, in the same transaction.",
  },
  "sponsored-fees": {
    title: "Sponsored fees",
    noun: "sponsored fees",
    summary:
      "Pays the network fee for an account sitting at its minimum balance, through a fee-bump envelope around the transaction you signed.",
  },
  "allowance-inspector": {
    title: "Allowance inspector",
    noun: "the allowance inspector",
    summary:
      "See every token approval your account granted to DeFi contracts, and revoke risky ones, even without closing.",
    linkLabel: "Open the allowance inspector",
  },
  "resumable-sessions": {
    title: "Resumable sessions",
    noun: "resumable sessions",
    summary:
      "Close the tab mid-flow and resume in the same browser: the account is re-read and a fresh plan covers only what is left, so confirmed work is not repeated.",
  },
  "deterministic-plan": {
    title: "Deterministic, auditable plan",
    noun: "deterministic plans",
    summary:
      "The same account state always produces the same ordered plan: testable, reviewable, never built on stale data.",
  },
};

const SERVER_KEYS: Record<"exchange-close" | "sponsored-fees", ServerKeyCopy> = {
  "exchange-close": {
    name: "Relay account key",
    statement:
      "In an exchange close, it co-signs only a two-operation transaction: your account's merge into the relay account and an XLM payment from it in the same transaction. Before you sign, your browser checks that this payment goes to the exchange address you typed.",
  },
  "sponsored-fees": {
    name: "Fee-sponsor key",
    statement:
      "When a fee is sponsored, it signs only the fee-bump envelope that pays the network fee for a transaction you already signed, and cannot change that transaction.",
  },
};

/** "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const en = {
  statusLabel: STATUS_LABEL,
  list,
  features: FEATURES,
  protocolExits: (protocol: string): string => `${protocol} exits`,
  /** What runs on testnet but not yet on mainnet, from the registry's names for it. */
  testnetOnly(names: readonly string[]): string {
    const listed = list(names);
    return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} run on testnet only today.`;
  },
  trust: {
    key: "Your secret key never reaches a LumenWipe server, and LumenWipe does not store or log it: you sign in your browser, through your wallet or a key held in memory for this session only.",
    check:
      "The LumenWipe API reads your account and builds each unsigned transaction. Before you sign, your browser decodes it and checks its operations and destination against what you entered; if they do not match, it stops before asking you to sign.",
    serverKeysIntro: "Two keys sign on the server, and neither can sign for your account.",
    serverKeys: SERVER_KEYS,
    scope: (statusLabel: string): string => `${statusLabel} today.`,
  },
  numbers: {
    reserveSource: "Stellar docs",
    reserveValue: (minimum: number, perItem: number): string =>
      `${minimum} XLM plus ${perItem} per item`,
    reserveLabel:
      "locked in reserve per account, where an item is a trustline, offer, data entry or signer",
    liveExitsLabel: "DeFi protocols with a mainnet exit",
    lastVerifiedLabel: "protocol contracts last checked against their live code",
    example: {
      minimum: "Account minimum",
      trustlines: (n: number): string => `${n} trustlines`,
      offers: (n: number): string => `${n} open offers`,
      dataAndSigner: (entries: number, signers: number): string =>
        `${entries} data entry · ${signers} signer`,
    },
    heroOutcome({
      minimum,
      perItem,
      defiLive,
    }: {
      minimum: number;
      perItem: number;
      defiLive: boolean;
    }): string {
      const exits = defiLive ? "exits your DeFi positions, " : "";
      return (
        `Get back the ${minimum} XLM every account must hold, plus ${perItem} XLM for each ` +
        `trustline, offer, data entry and signer. LumenWipe clears them, ${exits}converts leftover ` +
        "tokens to XLM and merges the balance into your wallet. You sign every transaction in your " +
        "browser."
      );
    },
  },
  metadata: {
    defaultTitle: "LumenWipe - Close a Stellar Account",
    homeTitle: "LumenWipe: Recover the XLM locked in your Stellar account",
    description:
      "Close your Stellar account safely. Recover locked XLM reserves, remove trustlines, cancel open offers, and exit Soroban DeFi positions in one non-custodial workflow.",
    keywords: [
      "Stellar",
      "XLM",
      "Lumens",
      "account merge",
      "non-custodial",
      "Soroban",
      "DeFi",
      "trustline",
      "blockchain",
      "LumenWipe",
    ],
    shareImageAlt: "LumenWipe: an example close plan and the XLM it recovers",
    shareCard: {
      eyebrow: "Example account",
      headline: "Close the account. Keep the lumens.",
      recovered: "Recovered on close",
    },
    blogDescription:
      "Technical deep dives, project updates, and guides on Stellar account management, trustline removal, reserve recovery, and non-custodial DeFi tooling.",
    blogName: (siteName: string): string => `${siteName} blog`,
  },
  structuredData: {
    home: "Home",
    blog: "Blog",
    /** The feature-list entry naming the protocols with a live exit, from the registry's names. */
    positionExits: (protocols: string): string => `Position exits: ${protocols}`,
  },
};

export type SiteCopy = typeof en;

const ES_STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Disponible",
  "testnet-only": "Solo en testnet",
  soon: "Próximamente",
};

const ES_FEATURES: Record<FeatureId, FeatureCopy> = {
  "classic-close": {
    title: "Cierre de cuentas clásicas",
    noun: "los cierres clásicos",
    summary:
      "Quita signers, data entries, offers y trustlines, convierte o devuelve los activos sobrantes y envía la cuenta con un merge a la billetera que elijas.",
  },
  "defi-exits": {
    title: "Salidas de DeFi en Soroban",
    noun: "las salidas de DeFi en Soroban",
    summary:
      "Detecta las posiciones con OctoPos y sale de cada una con el adaptador de su propio protocolo: paga préstamos, retira liquidez y retira lo que está en staking, antes de quitar la trustline.",
  },
  "exchange-close": {
    title: "Cierre compatible con exchanges",
    noun: "los cierres hacia un exchange",
    summary:
      "Una relay account (cuenta intermedia que reenvía el saldo) compartida recibe el merge y reenvía el saldo a la dirección de depósito de un exchange, con el memo (memo que identifica el depósito) que exige el exchange, en la misma transacción.",
  },
  "sponsored-fees": {
    title: "Comisiones patrocinadas",
    noun: "las comisiones patrocinadas",
    summary:
      "Paga la comisión de red de una cuenta que está en su saldo mínimo, con un fee bump (sobre que paga la comisión de otra transacción) alrededor de la transacción que firmaste.",
  },
  "allowance-inspector": {
    title: "Inspector de autorizaciones",
    noun: "el inspector de autorizaciones",
    summary:
      "Revisa cada autorización de tokens que tu cuenta otorgó a contratos de DeFi y revoca las riesgosas, incluso sin cerrar la cuenta.",
    linkLabel: "Abrir el inspector de autorizaciones",
  },
  "resumable-sessions": {
    title: "Sesiones reanudables",
    noun: "las sesiones reanudables",
    summary:
      "Cierra la pestaña a mitad del proceso y retómalo en el mismo navegador: la cuenta se vuelve a leer y un plan nuevo cubre solo lo que falta, así que el trabajo confirmado no se repite.",
  },
  "deterministic-plan": {
    title: "Plan determinista y auditable",
    noun: "los planes deterministas",
    summary:
      "El mismo estado de la cuenta siempre produce el mismo plan ordenado: se puede probar, se puede revisar y nunca se arma con datos desactualizados.",
  },
};

const ES_SERVER_KEYS: Record<"exchange-close" | "sponsored-fees", ServerKeyCopy> = {
  "exchange-close": {
    name: "Clave de la relay account",
    statement:
      "En un cierre hacia un exchange, solo cofirma una transacción de dos operaciones: el merge de tu cuenta hacia la relay account y un pago en XLM desde ella, en la misma transacción. Antes de que firmes, tu navegador verifica que ese pago vaya a la dirección del exchange que escribiste.",
  },
  "sponsored-fees": {
    name: "Clave del patrocinador de comisiones",
    statement:
      "Cuando se patrocina una comisión, solo firma el fee bump que paga la comisión de red de una transacción que ya firmaste, y no puede cambiar esa transacción.",
  },
};

const esList = (names: readonly string[]): string => formatList("es", names);

const es: SiteCopy = {
  statusLabel: ES_STATUS_LABEL,
  list: esList,
  features: ES_FEATURES,
  protocolExits: (protocol: string): string => `las salidas de ${protocol}`,
  testnetOnly(names: readonly string[]): string {
    const listed = esList(names);
    return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} funcionan solo en testnet por ahora.`;
  },
  trust: {
    key: "Tu clave secreta nunca llega a un servidor de LumenWipe, y LumenWipe no la guarda ni la registra: firmas en tu navegador, con tu billetera o con una clave que se mantiene en memoria solo durante esta sesión.",
    check:
      "La API de LumenWipe lee tu cuenta y arma cada transacción sin firmar. Antes de que firmes, tu navegador la decodifica y compara sus operaciones y su destino con lo que ingresaste; si no coinciden, se detiene antes de pedirte la firma.",
    serverKeysIntro:
      "Dos claves firman en el servidor, y ninguna de las dos puede firmar en nombre de tu cuenta.",
    serverKeys: ES_SERVER_KEYS,
    scope: (statusLabel: string): string => `${statusLabel} por ahora.`,
  },
  numbers: {
    reserveSource: "Documentación de Stellar",
    reserveValue: (minimum: number, perItem: number): string =>
      `${formatNumber("es", minimum)} XLM más ${formatNumber("es", perItem)} por elemento`,
    reserveLabel:
      "bloqueados en reserva por cuenta, donde un elemento es una trustline, una offer, un data entry o un signer",
    liveExitsLabel: "protocolos de DeFi con salida en mainnet",
    lastVerifiedLabel:
      "última revisión de los contratos de los protocolos contra su código en producción",
    example: {
      minimum: "Mínimo de la cuenta",
      trustlines: (n: number): string => plural("es", n, { one: "trustline", other: "trustlines" }),
      offers: (n: number): string =>
        plural("es", n, { one: "offer abierta", other: "offers abiertas" }),
      dataAndSigner: (entries: number, signers: number): string =>
        `${plural("es", entries, { one: "data entry", other: "data entries" })} · ${plural("es", signers, { one: "signer", other: "signers" })}`,
    },
    heroOutcome({
      minimum,
      perItem,
      defiLive,
    }: {
      minimum: number;
      perItem: number;
      defiLive: boolean;
    }): string {
      const exits = defiLive ? "sale de tus posiciones de DeFi, " : "";
      return (
        `Recupera el mínimo de ${formatNumber("es", minimum)} XLM que toda cuenta debe mantener, más ` +
        `${formatNumber("es", perItem)} XLM por cada trustline (línea de confianza con un emisor ` +
        "de activos), offer (orden abierta en el libro de órdenes), data entry (dato guardado en la " +
        `cuenta) y signer (firmante adicional de la cuenta). LumenWipe los elimina, ${exits}` +
        "convierte los tokens sobrantes a XLM y envía el saldo a tu billetera con un merge (fusión " +
        "que cierra la cuenta y envía su saldo). Firmas cada transacción en tu navegador."
      );
    },
  },
  metadata: {
    defaultTitle: "LumenWipe - Cierra una cuenta de Stellar",
    homeTitle: "LumenWipe: recupera el XLM bloqueado en tu cuenta de Stellar",
    description:
      "Cierra tu cuenta de Stellar de forma segura. Recupera las reservas de XLM bloqueadas, quita trustlines, cancela offers abiertas y sal de tus posiciones de DeFi en Soroban en un solo flujo no custodial.",
    keywords: [
      "Stellar",
      "XLM",
      "Lumens",
      "cerrar cuenta de Stellar",
      "merge de cuenta",
      "no custodial",
      "Soroban",
      "DeFi",
      "trustline",
      "blockchain",
      "LumenWipe",
    ],
    shareImageAlt: "LumenWipe: un plan de cierre de ejemplo y el XLM que recupera",
    shareCard: {
      eyebrow: "Cuenta de ejemplo",
      headline: "Cierra la cuenta. Quédate con los lumens.",
      recovered: "Recuperado al cerrar",
    },
    blogDescription:
      "Análisis técnicos, novedades del proyecto y guías sobre la gestión de cuentas de Stellar, la eliminación de trustlines, la recuperación de reservas y las herramientas de DeFi no custodiales.",
    blogName: (siteName: string): string => `Blog de ${siteName}`,
  },
  structuredData: {
    home: "Inicio",
    blog: "Blog",
    positionExits: (protocols: string): string => `Salidas de posiciones: ${protocols}`,
  },
};

export const SITE: Record<Locale, SiteCopy> = { en, es };
