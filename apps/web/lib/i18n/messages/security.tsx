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
      body: "Explicitly confirmed before signing. The full plan is shown up front, a destructive choice counts only for the exact destination or account you acknowledged, and your browser checks each transaction before your wallet asks you to approve it.",
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
      body: "Scripts get no unsafe-inline and no unsafe-eval: an inline script in the page runs only when the policy names it, by its hash on prerendered pages and by a per-request nonce elsewhere. Dependencies are lockfile-pinned and checked for known vulnerabilities in CI, and the web app contains no code that builds a transaction: a lint rule refuses it.",
    },
  },
  serverKeysHeading: "Keys on the server",
  openApp: "Open the app",
  securityModel: "Read the security model",
  evidence: {
    code: "Enforced in",
    tests: "Tested in",
  },
  fees: {
    heading: "What a close costs",
    intro:
      "LumenWipe charges nothing for a close. Its fees go to the Stellar network, and a token conversion you choose pays the aggregator's fee inside its quote. Each row names the code that sets or refuses the charge.",
    labels: {
      network: "Network fee",
      service: "Service fee",
      sponsored: "Sponsored fees",
      relay: "Relay account (exchange closes)",
      conversion: "Token conversion",
    },
    network: (stroops: string, xlm: string): string =>
      `The Stellar base fee, ${stroops} stroops (${xlm} XLM) per operation, paid to the network. A DeFi exit pays the fee its simulation reports instead, and your browser refuses one above a fixed cap.`,
    service:
      "None. Your browser refuses a transaction carrying any operation it cannot describe, so no charge can be added to a close.",
    sponsored:
      "When the fee sponsor is configured, it pays the network fee of each close transaction its rule accepts, through a fee bump; that transaction carries no fee of its own.",
    relay: (stroops: string): string =>
      `Your account is merged into a shared relay account that, in the same transaction, forwards the balance to the exchange with your memo. The forward is the balance less that transaction's network fee, ${stroops} stroops for its two operations, and your browser refuses a forward short of the balance it read by more than a small tolerance.`,
    conversion:
      "Optional. A token you choose to convert is swapped through the Soroswap aggregator, whose own fee is part of the quote you accept. A swap that names a fee partner is refused by the API and by your browser.",
  },
  build: {
    heading: "How to verify the build you are running",
    deployed: (commit: ReactNode): ReactNode => (
      <>
        {"This page was built from commit"} {commit}
        {". Open it to read the code this build was made from."}
      </>
    ),
    unknown:
      "This build carries no commit hash: only a deployment built from the repository sets one.",
    untagged:
      "The web app deploys continuously from main and has no release tag, so the commit is its version.",
  },
  disclosure: {
    heading: "Report a vulnerability",
    body: (email: ReactNode, policy: ReactNode, securityTxt: ReactNode): ReactNode => (
      <>
        {"Email"} {email}
        {
          ", and do not open a public issue. The scope, response times and disclosure process are in"
        }{" "}
        {policy}
        {"; the same contact is published in"} {securityTxt}.
      </>
    ),
    policyLink: "SECURITY.md",
  },
  reports: {
    heading: "Security reports",
    body: "What has been reviewed, by whom, and what it found: the reports page lists every published security report and, until one exists, the self-assessed documents there are today.",
    link: "See the security reports",
  },
  statusLink: "Service status",
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
      body: "Se confirma de forma explícita antes de firmar. El plan completo se muestra desde el inicio, una decisión destructiva solo vale para el destino o la cuenta exactos que aceptaste, y tu navegador verifica cada transacción antes de que tu billetera te pida aprobarla.",
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
      body: "Los scripts no tienen unsafe-inline ni unsafe-eval: un script inline de la página solo se ejecuta si la política lo nombra, por su hash en las páginas prerenderizadas y con un nonce por solicitud en las demás. Las dependencias están fijadas en el lockfile y CI busca en ellas vulnerabilidades conocidas, y la app web no tiene código que arme transacciones: una regla de lint lo impide.",
    },
  },
  serverKeysHeading: "Claves en el servidor",
  openApp: "Abrir la app",
  securityModel: "Leer el modelo de seguridad",
  evidence: {
    code: "Se aplica en",
    tests: "Se prueba en",
  },
  fees: {
    heading: "Lo que cuesta un cierre",
    intro:
      "LumenWipe no cobra nada por un cierre. Sus comisiones van a la red de Stellar, y una conversión de tokens que eliges paga la comisión del agregador dentro de su cotización. Cada fila nombra el código que fija o rechaza el cargo.",
    labels: {
      network: "Comisión de red",
      service: "Comisión de servicio",
      sponsored: "Comisiones patrocinadas",
      relay: "Relay account (cierres hacia exchanges)",
      conversion: "Conversión de tokens",
    },
    network: (stroops: string, xlm: string): string =>
      `La comisión base de Stellar, ${stroops} stroops (${xlm} XLM) por operación, que se paga a la red. Una salida de DeFi paga en su lugar la comisión que informa su simulación, y tu navegador rechaza una que supere un tope fijo.`,
    service:
      "Ninguna. Tu navegador rechaza una transacción que lleve cualquier operación que no sepa describir, así que no se puede añadir ningún cargo a un cierre.",
    sponsored:
      "Cuando el patrocinador de comisiones está configurado, paga la comisión de red de cada transacción del cierre que su regla acepta, con un fee bump; esa transacción no lleva comisión propia.",
    relay: (stroops: string): string =>
      `Tu cuenta se fusiona con una relay account compartida que, en la misma transacción, reenvía el saldo al exchange con tu memo. El reenvío es el saldo menos la comisión de red de esa transacción, ${stroops} stroops por sus dos operaciones, y tu navegador rechaza un reenvío que quede por debajo del saldo que leyó en más de un pequeño margen.`,
    conversion:
      "Opcional. Un token que eliges convertir se intercambia a través del agregador de Soroswap, cuya propia comisión ya está en la cotización que aceptas. Un intercambio que nombra un socio de comisiones (fee partner) lo rechazan la API y tu navegador.",
  },
  build: {
    heading: "Cómo verificar la versión que estás usando",
    deployed: (commit: ReactNode): ReactNode => (
      <>
        {"Esta página se generó a partir del commit"} {commit}
        {". Ábrelo para leer el código con el que se hizo esta versión."}
      </>
    ),
    unknown:
      "Esta versión no lleva hash de commit: solo lo fija un despliegue hecho desde el repositorio.",
    untagged:
      "La app web se despliega de forma continua desde main y no tiene etiqueta de versión, así que el commit es su versión.",
  },
  disclosure: {
    heading: "Reportar una vulnerabilidad",
    body: (email: ReactNode, policy: ReactNode, securityTxt: ReactNode): ReactNode => (
      <>
        {"Escribe a"} {email}
        {
          " y no abras un issue público. El alcance, los tiempos de respuesta y el proceso de divulgación están en"
        }{" "}
        {policy}
        {"; el mismo contacto se publica en"} {securityTxt}.
      </>
    ),
    policyLink: "SECURITY.md",
  },
  reports: {
    heading: "Reportes de seguridad",
    body: "Qué se ha revisado, quién lo hizo y qué encontró: la página de reportes lista cada reporte de seguridad publicado y, mientras no exista ninguno, los documentos de autoevaluación que hay hoy.",
    link: "Ver los reportes de seguridad",
  },
  statusLink: "Estado del servicio",
};

export const SECURITY: Record<Locale, SecurityCopy> = { en, es };
