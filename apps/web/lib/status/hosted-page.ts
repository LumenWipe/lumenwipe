/**
 * The hosted status page's public JSON (a JSON:API document: `data.type` is `status_page`, and
 * `included` carries one `status_page_resource` per row of the page), mapped onto the summary the
 * banner reads. Only a component id and a state leave this module.
 */
import {
  isRecord,
  STATUS_COMPONENT_IDS,
  type ComponentState,
  type StatusComponent,
  type StatusComponentId,
  type StatusSummary,
} from "@/lib/status/summary";

/**
 * The name each close-flow component carries on the status page. It is the page's contract, not
 * UI copy: a row under any other name (docs, playground) is never shown.
 */
export const HOSTED_COMPONENT_NAMES = {
  api: "API",
  web: "Web app",
  "user-path": "Account analysis and planning",
  "rpc-testnet": "Stellar RPC (testnet)",
  "rpc-mainnet": "Stellar RPC (mainnet)",
  "horizon-testnet": "Horizon (testnet)",
  "horizon-mainnet": "Horizon (mainnet)",
  indexer: "Indexer",
} as const satisfies Record<StatusComponentId, string>;

const COMPONENT_BY_NAME: ReadonlyMap<unknown, StatusComponentId> = new Map(
  STATUS_COMPONENT_IDS.map((id) => [HOSTED_COMPONENT_NAMES[id], id])
);

/**
 * A page status as a banner state. Null is a row the page does not monitor: it is left out, since
 * an unknown state is neither an all-clear nor an alarm.
 */
const STATE_BY_STATUS: ReadonlyMap<unknown, ComponentState | null> = new Map([
  ["operational", "operational"],
  ["degraded", "degraded"],
  ["maintenance", "degraded"],
  ["downtime", "outage"],
  ["not_monitored", null],
]);

export function isHostedStatusPage(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && isRecord(body.data) && body.data.type === "status_page";
}

/**
 * The summary in a hosted status page, in the order the page lists its rows. Null for a body that
 * is not a status page, for a close-flow component with a status this module does not know, or
 * for one listed twice.
 */
export function parseHostedStatusPage(body: unknown): StatusSummary | null {
  if (!isHostedStatusPage(body)) return null;
  const { included } = body;
  if (!Array.isArray(included)) return null;
  const seen = new Set<StatusComponentId>();
  const components: StatusComponent[] = [];
  for (const entry of included) {
    if (!isRecord(entry)) return null;
    if (entry.type !== "status_page_resource") continue;
    if (!isRecord(entry.attributes)) return null;
    const id = COMPONENT_BY_NAME.get(entry.attributes.public_name);
    if (!id) continue;
    if (seen.has(id)) return null;
    seen.add(id);
    const state = STATE_BY_STATUS.get(entry.attributes.status);
    if (state === undefined) return null;
    if (state) components.push({ id, state });
  }
  return { components };
}
