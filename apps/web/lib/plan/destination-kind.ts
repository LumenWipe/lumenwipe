import {
  activeRegistry,
  lookupExchange,
  mediatorAllowedFor,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import { isValidGAddress } from "@/lib/utils/validation";
import { memoBytes, type ConfirmedMemo } from "@/lib/plan/memo-field";

/**
 * A muxed (M...) address is never looked up by its base account: the close and `verify()` take
 * only a G address, so an M address is shown as not recognized rather than as the exchange.
 *
 * What kind of destination the review is about to send to, from the user's own inputs and the
 * registry `verify()` reads, never from an API answer.
 */
export type DestinationKind =
  | {
      kind: "exchange";
      name: string;
      memoRequired: boolean;
      /** How `verify()` holds the close: through the relay account, straight to the exchange,
       *  or neither, when the registry asks for the relay but cannot vouch for it. */
      route: ExchangeRoute;
      /** The day the registry was last checked, as YYYY-MM-DD. */
      lastVerified: string;
    }
  | { kind: "confirmed-wallet" }
  | { kind: "wallet" };

export type ExchangeRoute = "relay" | "direct" | "refused";

/**
 * Whether the balance reaches this destination through the shared relay account, read the way
 * `verify()` reads it: the bundled registry alone may enable the relay, and any entry asking for
 * it refuses a direct merge. Never from the store, so the screen cannot say "direct" for a close
 * `verify()` holds to the relay.
 */
export function relayRoute(destination: string): ExchangeRoute {
  if (mediatorAllowedFor(destination)) return "relay";
  return requiresMediatorForAddress(destination) ? "refused" : "direct";
}

/** The calendar date of a registry timestamp, the same in every timezone. */
export function isoDay(value: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return day ? day[0] : value;
}

export function destinationKind(
  destination: string,
  answers: { acknowledgedFor: string | null }
): DestinationKind {
  const entry = isValidGAddress(destination) ? lookupExchange(destination) : null;
  if (entry) {
    return {
      kind: "exchange",
      name: entry.name,
      memoRequired: entry.requiresMemo,
      route: relayRoute(destination),
      lastVerified: isoDay(activeRegistry().lastVerified),
    };
  }
  return answers.acknowledgedFor === destination
    ? { kind: "confirmed-wallet" }
    : { kind: "wallet" };
}

export interface MemoLine {
  /** "none", or the memo type. */
  label: string;
  /** The memo exactly as it goes on chain; null when there is none. */
  value: string | null;
  /** UTF-8 bytes of a text memo, so spaces or invisible characters in it still show. */
  bytes: number | null;
}

export function memoLine(memo: ConfirmedMemo | null): MemoLine {
  if (memo === null) return { label: "none", value: null, bytes: null };
  return {
    label: memo.memoType,
    value: memo.memo,
    bytes: memo.memoType === "text" ? memoBytes(memo.memo) : null,
  };
}

export interface MemoSegment {
  text: string;
  /** A control or format character (Unicode Cc or Cf), shown as its code point. */
  escaped: boolean;
}

const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * The memo split so every control or format character (a zero-width space, a direction override,
 * a byte order mark) is shown as `\u{XXXX}` instead of being drawn invisibly or reordering the
 * text around it. The memo itself is never changed: this is only how it is shown.
 */
export function memoSegments(value: string): MemoSegment[] {
  const segments: MemoSegment[] = [];
  for (const char of value) {
    if (INVISIBLE.test(char)) {
      const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      segments.push({ text: `\\u{${code}}`, escaped: true });
    } else if (segments.length > 0 && !segments[segments.length - 1].escaped) {
      segments[segments.length - 1].text += char;
    } else {
      segments.push({ text: char, escaped: false });
    }
  }
  return segments;
}
