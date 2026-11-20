import type { Locale } from "@/lib/i18n/locale";
import type { AffectedState, StatusComponentId } from "@/lib/status/summary";

const en = {
  components: {
    api: "API",
    web: "Web app",
    "user-path": "Account analysis and planning",
    "rpc-testnet": "Stellar RPC (testnet)",
    "rpc-mainnet": "Stellar RPC (mainnet)",
    "horizon-testnet": "Horizon (testnet)",
    "horizon-mainnet": "Horizon (mainnet)",
    indexer: "Indexer",
  } satisfies Record<StatusComponentId, string>,
  states: {
    degraded: "degraded",
    outage: "outage",
  } satisfies Record<AffectedState, string>,
  label: "Service status",
  details: "Status page",
};

export type StatusCopy = typeof en;

const es: StatusCopy = {
  components: {
    api: "API",
    web: "Aplicación web",
    "user-path": "Análisis y planificación de cuentas",
    "rpc-testnet": "Stellar RPC (testnet)",
    "rpc-mainnet": "Stellar RPC (mainnet)",
    "horizon-testnet": "Horizon (testnet)",
    "horizon-mainnet": "Horizon (mainnet)",
    indexer: "Indexador",
  },
  states: {
    degraded: "degradado",
    outage: "caída",
  },
  label: "Estado del servicio",
  details: "Página de estado",
};

export const STATUS: Record<Locale, StatusCopy> = { en, es };
