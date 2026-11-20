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

/** The global Umami calls on each payload before sending it (`data-before-send`). */
export const UMAMI_BEFORE_SEND = "lumenwipeRedactAnalytics";

/**
 * The same redaction for Umami, as an inline script that runs before Umami's deferred script
 * loads, so no payload is sent unredacted. It redacts the referrer too: on a client-side
 * navigation Umami reports the previous page there.
 */
export const UMAMI_BEFORE_SEND_SCRIPT = `window.${UMAMI_BEFORE_SEND}=function(type,payload){function r(u){return typeof u==="string"?u.split(/[?#]/)[0].replace(${RECEIPT_ID},"$1[id]"):u}return payload&&Object.assign({},payload,{url:r(payload.url),referrer:r(payload.referrer)})};`;
