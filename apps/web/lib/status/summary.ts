/**
 * The status summary the site banner reads from `/api/status`. The status host's JSON is mapped
 * onto this shape server-side, so the banner never renders a name, figure or link the host sent.
 */

/** The services the close flow calls. A component outside this list is never shown. */
export const STATUS_COMPONENT_IDS = [
  "api",
  "web",
  "user-path",
  "rpc-testnet",
  "rpc-mainnet",
  "horizon-testnet",
  "horizon-mainnet",
  "indexer",
] as const;

export type StatusComponentId = (typeof STATUS_COMPONENT_IDS)[number];

export const COMPONENT_STATES = ["operational", "degraded", "outage"] as const;

export type ComponentState = (typeof COMPONENT_STATES)[number];

export interface StatusComponent {
  id: StatusComponentId;
  state: ComponentState;
}

export interface StatusSummary {
  components: StatusComponent[];
}

/** What `/api/status` answers with a 200: the summary and the status page to link to. */
export interface StatusReport extends StatusSummary {
  page: string;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The summary in `body`, keeping only listed components with a known state and dropping every
 * other field (uptime figures included). Null for a body that is not a summary, or that names a
 * listed component twice.
 */
export function parseStatusSummary(body: unknown): StatusSummary | null {
  if (!isRecord(body) || !Array.isArray(body.components)) return null;
  const components: StatusComponent[] = [];
  for (const entry of body.components) {
    if (!isRecord(entry)) return null;
    if (!isOneOf(STATUS_COMPONENT_IDS, entry.id)) continue;
    if (!isOneOf(COMPONENT_STATES, entry.state)) return null;
    if (components.some((c) => c.id === entry.id)) return null;
    components.push({ id: entry.id, state: entry.state });
  }
  return { components };
}

export type AffectedState = Exclude<ComponentState, "operational">;

export interface AffectedComponent extends StatusComponent {
  state: AffectedState;
}

/** The components that are not operational, in the order the summary lists them. */
export function affectedComponents(summary: StatusSummary): AffectedComponent[] {
  return summary.components.filter((c): c is AffectedComponent => c.state !== "operational");
}
