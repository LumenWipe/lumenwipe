export type UpstreamKind = "rpc" | "horizon" | "defi";

/** Hosts the API calls without an endpoint variable. */
const FIXED_HOSTS: Record<string, string> = {
  "api.stellar.expert": "explorer",
  "stellarview.acachete.xyz": "explorer",
  "swap-api.xbull.io": "quotes",
};

const WORD = /^[a-z][a-z_-]*$/;

function matchBase(href: string, upstreams: Record<string, UpstreamKind>) {
  let best: { base: string; kind: UpstreamKind } | undefined;
  for (const [base, kind] of Object.entries(upstreams)) {
    const prefix = base.replace(/\/+$/, "");
    if (
      (href === prefix || href.startsWith(`${prefix}/`) || href.startsWith(`${prefix}?`)) &&
      (!best || prefix.length > best.base.length)
    ) {
      best = { base: prefix, kind };
    }
  }
  return best;
}

function rpcMethod(body: string | undefined): string {
  if (!body) return "call";
  try {
    const parsed: unknown = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const method = (first as { method?: unknown } | null)?.method;
    return typeof method === "string" && /^[A-Za-z]+$/.test(method) ? method : "call";
  } catch {
    return "call";
  }
}

/**
 * A label for one outgoing request that never carries a host, a query, an address or a key:
 * the upstream kind, then the JSON-RPC method or the lowercase route words of the path below the
 * configured base URL (`horizon:accounts/offers`).
 */
export function spanLabel(
  href: string,
  body: string | undefined,
  upstreams: Record<string, UpstreamKind>
): string {
  const match = matchBase(href, upstreams);
  if (match) {
    if (match.kind === "rpc") return `rpc:${rpcMethod(body)}`;
    if (match.kind === "defi") return "defi";
    const rest = href.slice(match.base.length).split(/[?#]/)[0];
    const words = rest
      .split("/")
      .filter((s) => WORD.test(s))
      .slice(0, 2);
    return words.length > 0 ? `horizon:${words.join("/")}` : "horizon";
  }
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return "other";
  }
  return FIXED_HOSTS[host] ?? "other";
}
