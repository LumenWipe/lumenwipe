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
      body: "Scripts get no unsafe-inline and no unsafe-eval: an inline script in the page runs only when the policy names it, by its hash on prerendered pages and by a per-request nonce elsewhere. Dependencies are lockfile-pinned and audited in CI; the transaction builder is a pure, unit-tested module with zero network side effects.",
    },
  },
  serverKeysHeading: "Keys on the server",
  openApp: "Open the app",
  securityModel: "Read the security model",
};

export type SecurityCopy = typeof en;

const es: SecurityCopy = {
  metadata: {
    title: "Seguridad",
    description:
      "Cómo LumenWipe mantiene tu clave en tu navegador, qué arma su API, qué verifica tu navegador antes de que firmes, y las dos claves del servidor y qué puede firmar cada una.",
  },
  eyebrow: "Modelo de confianza",
  heading: "El límite de confianza es tu navegador.",
  lede: (keyStatement: string, checkStatement: string): ReactNode => (
    <>
      {
        "LumenWipe arma transacciones que vacían cuentas de forma irreversible, así que el diseño parte de ese hecho. "
      }
      {keyStatement} {checkStatement}
    </>
  ),
  openSource: (verifyLink: ReactNode, registryLink: ReactNode): ReactNode => (
    <>
      {"La verificación es de código abierto:"} {verifyLink}
      {
        ". Los exchanges y las reglas de memo (memo que identifica el depósito) con los que compara, y los protocolos de los que puede salir, están en el"
      }{" "}
      {registryLink}.
    </>
  ),
  verifyLink: "lee verify.ts en GitHub",
  registryLink: "registro de exchanges",
  layers: {
    browser: {
      label: "Tu navegador",
      sub: "Billetera · verificación de transacciones · firma · sesión",
      note: "tu clave se queda aquí",
    },
    api: {
      label: "API de LumenWipe",
      sub: "Lecturas de la cuenta · adaptadores de DeFi · arma transacciones sin firmar · claves de la relay account (cuenta intermedia que reenvía el saldo) y del patrocinador de comisiones",
      note: "nunca tiene tu clave",
    },
    network: {
      label: "Red de Stellar y datos",
      sub: "Stellar RPC · Horizon · Soroswap API",
      note: "lectura · simulación · envío",
    },
  },
  keyStays: "Tu clave se queda en tu navegador",
  guarantees: {
    key: {
      title: "Clave privada",
      body: "Nunca se transmite. Se queda en tu billetera, o en memoria solo mientras dura el cierre, nunca se guarda y se borra cuando terminas, cancelas o sales de la página.",
    },
    steps: {
      title: "Cada paso destructivo",
      body: "Se revisa como XDR sin procesar y se confirma de forma explícita antes de firmar. El plan completo se muestra desde el inicio y cada paso se simula primero.",
    },
    memo: {
      title: "Memo del exchange",
      body: "Es obligatorio y se valida contra un registro de exchanges conocidos que exige el tipo de memo; si falta el memo, el envío se bloquea para que los depósitos no se pierdan.",
    },
    api: {
      title: "Si la API se ve comprometida",
      body: "No tiene ninguna clave que pueda firmar en nombre de tu cuenta, y tu navegador verifica las operaciones y el destino de cada transacción que arma antes de que firmes. Las cifras que tu navegador solo puede tomar de las propias lecturas de la API, como una cotización de conversión, se te muestran para que las aceptes.",
    },
    csp: {
      title: "CSP estricta",
      body: "Los scripts no tienen unsafe-inline ni unsafe-eval: un script inline de la página solo se ejecuta si la política lo nombra, por su hash en las páginas prerenderizadas y con un nonce por solicitud en las demás. Las dependencias están fijadas en el lockfile y se auditan en CI; el módulo que arma las transacciones es puro, tiene pruebas unitarias y no tiene ningún efecto secundario de red.",
    },
  },
  serverKeysHeading: "Claves en el servidor",
  openApp: "Abrir la app",
  securityModel: "Leer el modelo de seguridad",
};

export const SECURITY: Record<Locale, SecurityCopy> = { en, es };
