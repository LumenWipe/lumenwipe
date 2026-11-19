import type { FaqItem } from "@/components/marketing/FaqAccordion";
import type { Locale } from "@/lib/i18n/locale";

/** The registry facts and trust statements the answers are built from, so each answer follows
 *  the registry instead of freezing what it said when it was written. */
export interface FaqFacts {
  keyStatement: string;
  checkStatement: string;
  serverKeysIntro: string;
  serverKeys: readonly { name: string; statement: string; scope: string }[];
  verifySourceUrl: string;
  newTab: string;
  exchangeLive: boolean;
  /** The protocols with a mainnet exit, as a list. */
  liveExits: string;
  /** The protocols whose exits run on testnet only, as a list; "" when there are none. */
  testnetOnlyExits: string;
  testnetOnlySentence: string;
  /** The minimum balance and the reserve per subentry in XLM, each formatted for the reader. */
  minimumBalance: string;
  perItem: string;
}

/** An amount of XLM as the answers show it, in one text node. */
const xlm = (amount: string) => <span className="text-value">{`${amount} XLM`}</span>;

const items = (ctx: FaqFacts): readonly FaqItem[] => [
  {
    q: "Is LumenWipe really non-custodial?",
    a: (
      <>
        Yes. {ctx.keyStatement} {ctx.checkStatement} {ctx.serverKeysIntro}{" "}
        {ctx.serverKeys.map((key) => (
          <span key={key.name}>
            {key.name}: {key.statement} {key.scope}{" "}
          </span>
        ))}
        The check is open source:{" "}
        <a
          href={ctx.verifySourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-4"
        >
          verify.ts<span className="sr-only">{ctx.newTab}</span>
        </a>
        .
      </>
    ),
  },
  {
    q: "Is closing an account reversible?",
    a: (
      <>
        No. The final merge permanently removes the account from the Stellar ledger. Because the
        action is irreversible, LumenWipe shows the complete plan up front, simulates each step, and
        asks for explicit confirmation (with the raw transaction available to review) before every
        signature.
      </>
    ),
  },
  {
    q: "How much XLM will I actually get back?",
    a: (
      <>
        Everything recoverable. Stellar requires a {xlm(ctx.minimumBalance)} minimum balance (two
        base reserves) plus {xlm(ctx.perItem)} for each subentry: every trustline, open offer, data
        entry, and extra signer. LumenWipe unwinds all of them to release those reserves, converts
        leftover tokens to XLM, and sweeps the full balance to your destination.
      </>
    ),
  },
  {
    q: "Can I send the recovered XLM straight to an exchange?",
    a: (
      <>
        {ctx.exchangeLive ? "Yes." : "On testnet today."} Exchanges don&apos;t accept an account
        merge as a deposit, so LumenWipe routes the final merge through a relay account: a shared
        account that receives the merge and, in the same transaction, pays the balance out to your
        deposit address with the correct memo. Known exchanges are validated against a registry that
        enforces the required memo type, so deposits don&apos;t go missing.
        {ctx.exchangeLive
          ? ""
          : " On mainnet, the plan blocks an exchange close until the relay account is deployed there, so close to a wallet you control instead."}
      </>
    ),
  },
  {
    q: "Does it handle Soroban DeFi positions?",
    a: (
      <>
        Yes. LumenWipe detects positions through OctoPos and exits them in{" "}
        <span className="text-white/80">{ctx.liveExits}</span> on mainnet
        {ctx.testnetOnlyExits !== "" && (
          <>
            ;{" "}
            <span data-site-status="testnet-only">
              <span className="text-white/80">{ctx.testnetOnlyExits}</span> exits run on testnet
              only
            </span>
          </>
        )}
        . Classic order-book offers are cancelled as part of every close. Classic AMM pool shares
        are not unwound: they are reported as a blocker, so withdraw your liquidity from the pool
        first.
      </>
    ),
  },
  {
    q: "Which wallets are supported?",
    a: (
      <>
        Any wallet that Stellar Wallets Kit connects: Varial (formerly Freighter), xBull, Albedo,
        LOBSTR, Hana, WalletConnect and more. Power users can also use an advanced secret-key mode
        where the key is held in memory only for the duration of the close, never persisted and
        never sent to a server, and cleared when you finish, abort, navigate away, or click
        &quot;Forget key&quot;.
      </>
    ),
  },
  {
    q: "What if I close the tab in the middle?",
    a: (
      <>
        Anything already confirmed on the network stays done. Once you confirm the plan, this
        browser keeps a small record of the close: the account, the destination, the memo and the
        hash of any transaction still waiting, never your keys. When you come back in the same
        browser, the home page offers to resume: LumenWipe re-reads the account and builds a fresh
        plan for what is left, which you review and sign again, so confirmed work is not repeated.
        If a transaction was still waiting for the network, you check its outcome first. Your
        per-asset choices are kept only in this tab, so a reload shows them again for you to check;
        in another tab, or once this one is closed, you make them again.
      </>
    ),
  },
  {
    q: "Mainnet or testnet?",
    a: (
      <>
        Both. Run the entire flow on testnet with no real funds at risk to see exactly what will
        happen, then switch to mainnet for the real close.{" "}
        <span data-site-status="testnet-only">{ctx.testnetOnlySentence}</span> Closing an account on
        mainnet is irreversible and entirely at your own risk: review each step, the simulation
        result, and the destination address before you sign anything.
      </>
    ),
  },
];

const en = {
  eyebrow: "FAQ",
  heading: "Questions, answered.",
  lede: "Closing an account is irreversible. Here's exactly how LumenWipe keeps it safe.",
  items,
  page: {
    title: "FAQ",
    description:
      "Answers to the common questions about closing a Stellar account with LumenWipe: non-custodial signing, irreversibility, exchange merges, Soroban DeFi, supported wallets and resumable sessions.",
    openApp: "Open the app",
    docs: "Read the documentation",
  },
};

export type FaqCopy = typeof en;

const esItems = (ctx: FaqFacts): readonly FaqItem[] => [
  {
    q: "¿LumenWipe es realmente no custodial?",
    a: (
      <>
        Sí. {ctx.keyStatement} {ctx.checkStatement} {ctx.serverKeysIntro}{" "}
        {ctx.serverKeys.map((key) => (
          <span key={key.name}>
            {key.name}: {key.statement} {key.scope}{" "}
          </span>
        ))}
        La verificación es de código abierto:{" "}
        <a
          href={ctx.verifySourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-4"
        >
          verify.ts<span className="sr-only">{ctx.newTab}</span>
        </a>
        .
      </>
    ),
  },
  {
    q: "¿Se puede revertir el cierre de una cuenta?",
    a: (
      <>
        No. El merge final (fusión que cierra la cuenta y envía su saldo) elimina la cuenta del
        ledger de Stellar para siempre. Como la acción es irreversible, LumenWipe te muestra el plan
        completo desde el principio, simula cada paso y te pide una confirmación explícita (con la
        transacción en bruto disponible para revisar) antes de cada firma.
      </>
    ),
  },
  {
    q: "¿Cuánto XLM voy a recuperar?",
    a: (
      <>
        Todo lo que se puede recuperar. Stellar exige un saldo mínimo de {xlm(ctx.minimumBalance)}{" "}
        (dos base reserves, reserva mínima por elemento) más {xlm(ctx.perItem)} por cada subentry
        (elemento que bloquea reserva): cada trustline (línea de confianza con un emisor de
        activos), offer abierta (orden abierta en el libro de órdenes), data entry (dato guardado en
        la cuenta) y signer extra (firmante adicional de la cuenta). LumenWipe los deshace todos
        para liberar esas reservas, convierte los tokens sobrantes a XLM y envía el saldo completo a
        tu destino.
      </>
    ),
  },
  {
    q: "¿Puedo enviar el XLM recuperado directo a un exchange?",
    a: (
      <>
        {ctx.exchangeLive ? "Sí." : "Por ahora, en testnet."} Los exchanges no aceptan un merge como
        depósito, así que LumenWipe hace el merge final a través de una relay account (cuenta
        intermedia que reenvía el saldo): una cuenta compartida que recibe el merge y, en la misma
        transacción, paga el saldo a tu dirección de depósito con el memo correcto (memo que
        identifica el depósito). Los exchanges conocidos se validan contra un registro que exige el
        tipo de memo que cada uno requiere, para que los depósitos no se pierdan.
        {ctx.exchangeLive
          ? ""
          : " En mainnet, el plan bloquea un cierre hacia un exchange hasta que la relay account esté desplegada ahí, así que por ahora cierra hacia una billetera que controles."}
      </>
    ),
  },
  {
    q: "¿Maneja posiciones de DeFi en Soroban?",
    a: (
      <>
        Sí. LumenWipe detecta las posiciones con OctoPos y sale de ellas en{" "}
        <span className="text-white/80">{ctx.liveExits}</span> en mainnet
        {ctx.testnetOnlyExits !== "" && (
          <>
            ;{" "}
            <span data-site-status="testnet-only">
              las salidas de <span className="text-white/80">{ctx.testnetOnlyExits}</span> funcionan
              solo en testnet
            </span>
          </>
        )}
        . Las offers del libro de órdenes clásico se cancelan en cada cierre. Las pool shares
        (participaciones en un pool de liquidez AMM) clásicas no se deshacen: se reportan como un
        bloqueo, así que primero retira tu liquidez del pool.
      </>
    ),
  },
  {
    q: "¿Qué billeteras son compatibles?",
    a: (
      <>
        Cualquier billetera que conecte Stellar Wallets Kit: Varial (antes Freighter), xBull,
        Albedo, LOBSTR, Hana, WalletConnect y más. Si tienes experiencia, también puedes usar un
        modo avanzado con tu clave secreta, en el que la clave se mantiene en memoria solo mientras
        dura el cierre, nunca se guarda ni se envía a un servidor, y se borra cuando terminas,
        cancelas, sales de la página o haces clic en el botón &quot;Forget key&quot;.
      </>
    ),
  },
  {
    q: "¿Qué pasa si cierro la pestaña a mitad del proceso?",
    a: (
      <>
        Lo que ya se confirmó en la red queda hecho. Cuando confirmas el plan, este navegador guarda
        un pequeño registro del cierre: la cuenta, el destino, el memo y el hash de cualquier
        transacción que siga pendiente, nunca tus claves. Cuando vuelves en el mismo navegador, la
        página de inicio te ofrece retomarlo: LumenWipe vuelve a leer la cuenta y arma un plan nuevo
        con lo que falta, que revisas y firmas de nuevo, así que el trabajo confirmado no se repite.
        Si una transacción seguía esperando a la red, primero revisas cómo terminó. Tus decisiones
        para cada activo se guardan solo en esta pestaña, así que al recargarla las vuelves a ver
        para revisarlas; en otra pestaña, o cuando cierres esta, las tomas de nuevo.
      </>
    ),
  },
  {
    q: "¿Mainnet o testnet?",
    a: (
      <>
        Las dos. Haz todo el flujo en testnet, sin fondos reales en riesgo, para ver exactamente qué
        va a pasar, y después cambia a mainnet para el cierre real.{" "}
        <span data-site-status="testnet-only">{ctx.testnetOnlySentence}</span> Cerrar una cuenta en
        mainnet es irreversible y corre por tu cuenta y riesgo: revisa cada paso, el resultado de la
        simulación y la dirección de destino antes de firmar.
      </>
    ),
  },
];

const es: FaqCopy = {
  eyebrow: "Preguntas frecuentes",
  heading: "Tus preguntas, respondidas.",
  lede: "Cerrar una cuenta es irreversible. Así es exactamente como LumenWipe lo hace de forma segura.",
  items: esItems,
  page: {
    title: "Preguntas frecuentes",
    description:
      "Respuestas a las preguntas comunes sobre cómo cerrar una cuenta de Stellar con LumenWipe: firma no custodial, irreversibilidad, cierres hacia exchanges, DeFi en Soroban, billeteras compatibles y sesiones que puedes retomar.",
    openApp: "Abrir la app",
    docs: "Leer la documentación",
  },
};

export const FAQ: Record<Locale, FaqCopy> = { en, es };
