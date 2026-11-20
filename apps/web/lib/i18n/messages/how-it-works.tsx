import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "How it works",
    description:
      "How LumenWipe closes a Stellar account: a deterministic ordered plan, per-step simulation and confirmation, the CEX relay flow, and resumable sessions reconciled against on-chain state.",
  },
  hero: {
    eyebrow: "How it works",
    heading: "A deterministic plan for an irreversible action.",
    body: "Closing an account takes one or more transactions in the right order. LumenWipe shows the whole plan up front, then executes it one transaction at a time, each confirmed before the next, re-reading live state and simulating before every signature, so nothing is ever signed on stale data.",
    openApp: "Open the app",
    faq: "Jump to FAQ",
  },
  loop: {
    eyebrow: "The execution loop",
    heading: "Every step runs the same safe loop.",
    body: "No step trusts a cached value. Each one reconciles against the live ledger, simulates, and waits for your explicit approval before a single byte is signed.",
    steps: {
      reread: { label: "Re-read live state", note: "getLedgerEntries" },
      simulate: { label: "Simulate", note: "simulateTransaction" },
      confirm: { label: "Confirm", note: "you approve" },
      sign: { label: "Sign in browser", note: "your wallet" },
      submit: { label: "Submit XDR", note: "to Stellar RPC" },
      poll: { label: "Poll & advance", note: "next step" },
    },
    repeats: "repeats for every step in the plan",
  },
  plan: {
    eyebrow: "The plan",
    heading: "Eight ordered steps, every reserve accounted for.",
    opLabel: "op",
    steps: {
      analyze: {
        title: "Analyze the account",
        body: "Enumerate every subentry (trustlines, offers, data entries, signers) and detect DeFi positions through OctoPos. The result is a single, ordered execution plan.",
        op: "Horizon + Stellar RPC",
      },
      signers: {
        title: "Normalize signers",
        body: "Remove extra signers and reset thresholds so a single key can authorize every remaining step without surprises mid-flow.",
        op: "SetOptions",
      },
      data: {
        title: "Remove data entries",
        body: (perItem: string): string =>
          `Clear every ManageData entry in batches, releasing ${perItem} XLM of reserve each.`,
        op: "ManageData (value = null)",
      },
      offers: {
        title: "Cancel DEX offers",
        body: "Close all open order-book offers, freeing the reserve each one holds.",
        op: "ManageSellOffer / ManageBuyOffer · amount = 0",
      },
      defi: {
        title: "Exit DeFi positions",
        body: "Exit every supported Soroban protocol position, repaying loans and unstaking first where needed, via each protocol's own adapter. Classic AMM pool shares are withdrawn in full.",
        op: (protocols: readonly string[]): string =>
          `InvokeHostFunction · ${protocols.join(" · ")}`,
      },
      convert: {
        title: "Convert assets to XLM",
        body: "Swap every remaining token to XLM along the best available route across Soroban and classic venues.",
        op: "Soroswap API · SDEX path payments",
      },
      trustlines: {
        title: "Remove trustlines",
        body: (perItem: string): string =>
          `Once a balance is zero, remove its trustline and release the ${perItem} XLM reserve.`,
        op: "ChangeTrust · limit = 0",
      },
      merge: {
        title: "Merge the account",
        body: "Execute the final merge, directly to a wallet or through a relay account for an exchange destination. The base reserve comes back too.",
        op: "AccountMerge",
      },
    },
  },
  relay: {
    eyebrow: "Exchange destinations",
    heading: "The CEX relay flow.",
    body: (code: (text: string) => ReactNode): ReactNode => (
      <>
        {"Exchanges don't support"} {code("ACCOUNT_MERGE")}
        {
          ". LumenWipe bridges the gap with one shared relay account: the merge sends your balance into it and, in the same transaction, it pays that balance on to your deposit address with the memo. Its key stays on the LumenWipe API, which co-signs only that payment, and your browser checks that the payment goes to the address you typed before you sign."
        }
      </>
    ),
    nodes: {
      source: { label: "Source account", sub: "the account you're closing" },
      merge: "AccountMerge",
      relay: { label: "Relay account", sub: "shared · co-signed by the API" },
      payment: "Payment + memo",
      exchange: { label: "Exchange deposit", sub: "validated address & memo" },
    },
    footnote:
      "The relay account forwards your whole balance less a two-operation network fee, so none of your reserve stays behind, and the review names the exchange and the relay route before you sign. Known exchanges are validated against a registry that enforces the correct memo type.",
  },
  resume: {
    eyebrow: "Resumable by design",
    heading: "Close the tab. Pick up where you left off.",
    body: "The close moves through these phases in your browser. Once you confirm the plan, the browser keeps a small record of the close, never your keys. On return, LumenWipe re-reads the account and builds a fresh plan for what is left, which you review and sign again, so confirmed work is not repeated.",
    phases: [
      "Idle",
      "Analyzing",
      "PreflightComplete",
      "StepExecuting",
      "StepConfirmed",
      "Complete",
    ],
  },
  architecture: {
    eyebrow: "Architecture",
    heading: "Three layers, one trust boundary.",
    body: "No bespoke indexer. Every read source sits behind an adapter, so any compatible provider can be swapped in without touching the rest of the system.",
    rows: {
      browser: {
        label: "Browser",
        sub: "UI · wallet · transaction check · signing · session",
        note: "your key stays here",
      },
      api: {
        label: "LumenWipe API",
        sub: "reads · DeFi adapters · routing · builds unsigned transactions",
        note: "never holds your key",
      },
      network: {
        label: "Stellar network",
        sub: "Stellar RPC · Horizon · Soroswap",
        note: "read · submit",
      },
    },
  },
  faq: {
    eyebrow: "FAQ",
    heading: "Questions, answered.",
  },
  ready: {
    heading: "Ready when you are.",
    openApp: "Open the app",
  },
};

export type HowItWorksCopy = typeof en;

const es: HowItWorksCopy = {
  metadata: {
    title: "Cómo funciona",
    description:
      "Cómo LumenWipe cierra una cuenta de Stellar: un plan determinista y ordenado, simulación y confirmación en cada paso, el flujo de relay para exchanges centralizados y sesiones reanudables que se concilian con el estado on-chain.",
  },
  hero: {
    eyebrow: "Cómo funciona",
    heading: "Un plan determinista para una acción irreversible.",
    body: "Cerrar una cuenta toma una o más transacciones en el orden correcto. LumenWipe te muestra el plan completo desde el inicio y luego lo ejecuta una transacción a la vez, cada una confirmada antes de la siguiente, volviendo a leer el estado en vivo y simulando antes de cada firma, para que nunca se firme nada con datos desactualizados.",
    openApp: "Abrir la app",
    faq: "Ir a las preguntas frecuentes",
  },
  loop: {
    eyebrow: "El ciclo de ejecución",
    heading: "Cada paso sigue el mismo ciclo seguro.",
    body: "Ningún paso confía en un valor guardado en caché. Cada uno se concilia con el ledger en vivo, se simula y espera tu aprobación explícita antes de firmar un solo byte.",
    steps: {
      reread: { label: "Volver a leer el estado en vivo", note: "getLedgerEntries" },
      simulate: { label: "Simular", note: "simulateTransaction" },
      confirm: { label: "Confirmar", note: "tú lo apruebas" },
      sign: { label: "Firmar en el navegador", note: "tu billetera" },
      submit: { label: "Enviar el XDR", note: "a Stellar RPC" },
      poll: { label: "Consultar y avanzar", note: "siguiente paso" },
    },
    repeats: "se repite en cada paso del plan",
  },
  plan: {
    eyebrow: "El plan",
    heading: "Ocho pasos ordenados, con cada reserva contabilizada.",
    opLabel: "op",
    steps: {
      analyze: {
        title: "Analizar la cuenta",
        body: "Enumera cada subentry (elemento que bloquea reserva): trustlines (líneas de confianza con un emisor de activos), offers (órdenes abiertas en el libro de órdenes), data entries (datos guardados en la cuenta) y signers (firmantes adicionales de la cuenta), y detecta las posiciones de DeFi con OctoPos. El resultado es un único plan de ejecución ordenado.",
        op: "Horizon + Stellar RPC",
      },
      signers: {
        title: "Normalizar los signers",
        body: "Quita los signers adicionales y restablece los umbrales para que una sola clave pueda autorizar todos los pasos restantes sin sorpresas a mitad del flujo.",
        op: "SetOptions",
      },
      data: {
        title: "Quitar los data entries",
        body: (perItem: string): string =>
          `Borra cada data entry con ManageData, por lotes, y libera ${perItem} XLM de reserva por cada uno.`,
        op: "ManageData (value = null)",
      },
      offers: {
        title: "Cancelar las offers del DEX",
        body: "Cierra todas las offers abiertas del libro de órdenes y libera la reserva que bloquea cada una.",
        op: "ManageSellOffer / ManageBuyOffer · amount = 0",
      },
      defi: {
        title: "Salir de las posiciones de DeFi",
        body: "Sale de cada posición en un protocolo de Soroban compatible, pagando préstamos y retirando lo que está en staking primero cuando hace falta, con el adaptador propio de cada protocolo. Las pool shares (participaciones en un pool de liquidez AMM) clásicas se retiran por completo.",
        op: en.plan.steps.defi.op,
      },
      convert: {
        title: "Convertir los activos a XLM",
        body: "Cambia cada token restante a XLM por la mejor ruta disponible entre los mercados de Soroban y los clásicos.",
        op: "Soroswap API · SDEX path payments",
      },
      trustlines: {
        title: "Quitar las trustlines",
        body: (perItem: string): string =>
          `Cuando un saldo queda en cero, quita su trustline y libera los ${perItem} XLM de reserva.`,
        op: "ChangeTrust · limit = 0",
      },
      merge: {
        title: "Hacer el merge de la cuenta",
        body: "Ejecuta el merge (fusión que cierra la cuenta y envía su saldo) final, directo a una billetera o a través de una relay account (cuenta intermedia que reenvía el saldo) si el destino es un exchange. La base reserve (unidad de reserva que fija la red) también vuelve.",
        op: "AccountMerge",
      },
    },
  },
  relay: {
    eyebrow: "Destinos en exchanges",
    heading: "El flujo de relay para exchanges centralizados.",
    body: (code: (text: string) => ReactNode): ReactNode => (
      <>
        {"Los exchanges no admiten"} {code("ACCOUNT_MERGE")}
        {
          ". LumenWipe resuelve esto con una sola relay account compartida: el merge envía tu saldo a ella y, en la misma transacción, ella reenvía ese saldo a tu dirección de depósito con el memo (memo que identifica el depósito). Su clave se queda en la API de LumenWipe, que solo cofirma ese pago, y tu navegador verifica que el pago vaya a la dirección que escribiste antes de que firmes."
        }
      </>
    ),
    nodes: {
      source: { label: "Cuenta de origen", sub: "la cuenta que estás cerrando" },
      merge: "AccountMerge",
      relay: { label: "Relay account", sub: "compartida · cofirmada por la API" },
      payment: "Payment + memo",
      exchange: { label: "Depósito en el exchange", sub: "dirección y memo validados" },
    },
    footnote:
      "La relay account reenvía todo tu saldo menos una comisión de red de dos operaciones, así que nada de tu reserva se queda atrás, y la revisión te muestra el exchange y la ruta por la relay account antes de que firmes. Los exchanges conocidos se validan contra un registro que exige el tipo de memo correcto.",
  },
  resume: {
    eyebrow: "Reanudable por diseño",
    heading: "Cierra la pestaña. Retoma donde lo dejaste.",
    body: "El cierre pasa por estas fases en tu navegador. Una vez que confirmas el plan, el navegador guarda un pequeño registro del cierre, nunca tus claves. Cuando vuelves, LumenWipe vuelve a leer la cuenta y arma un plan nuevo con lo que falta, que revisas y firmas de nuevo, así que el trabajo ya confirmado no se repite.",
    phases: en.resume.phases,
  },
  architecture: {
    eyebrow: "Arquitectura",
    heading: "Tres capas, un límite de confianza.",
    body: "Sin un indexador propio. Cada fuente de lectura está detrás de un adaptador, así que se puede cambiar por cualquier proveedor compatible sin tocar el resto del sistema.",
    rows: {
      browser: {
        label: "Navegador",
        sub: "UI · billetera · verificación de transacciones · firma · sesión",
        note: "tu clave se queda aquí",
      },
      api: {
        label: "API de LumenWipe",
        sub: "lecturas · adaptadores de DeFi · rutas · arma transacciones sin firmar",
        note: "nunca tiene tu clave",
      },
      network: {
        label: "Red de Stellar",
        sub: "Stellar RPC · Horizon · Soroswap",
        note: "lectura · envío",
      },
    },
  },
  faq: {
    eyebrow: "Preguntas frecuentes",
    heading: "Tus preguntas, respondidas.",
  },
  ready: {
    heading: "Empieza cuando quieras.",
    openApp: "Abrir la app",
  },
};

export const HOW_IT_WORKS: Record<Locale, HowItWorksCopy> = { en, es };
