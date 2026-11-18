import type { BeforeSendEvent } from "@vercel/analytics/next";

const RECEIPT_ID = /(\/receipt\/)[^/?#]+/;

/**
 * The page address analytics may see. The query and fragment are dropped from every address,
 * since a query can carry an account address (`?source=`, `?address=`), and a receipt's id is
 * replaced by a placeholder. The scripts that build the reported address are served by the
 * analytics providers, not shipped in their packages, so nothing here relies on what they drop.
 */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  return path.replace(RECEIPT_ID, "$1[id]");
}

export function redactEvent(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: redactUrl(event.url) };
}
