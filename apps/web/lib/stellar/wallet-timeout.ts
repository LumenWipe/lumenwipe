/**
 * How long a wallet's signing prompt is waited on before the close gives up on it.
 *
 * The longest wait. A prompt that is still open after two minutes is a closed popup, a locked
 * extension or a stalled relay far more often than a person still reading it, and a retry asks
 * again with a freshly built transaction.
 */
export const WALLET_SIGN_TIMEOUT_MS = 120_000;

/**
 * The shortest wait. The window is read against this device's clock, which can be wrong: a
 * clock running fast would otherwise leave no time at all and refuse every signature, where a
 * secret key would still sign. A transaction that has really expired is refused by the network
 * (`tx_too_late`) before it is applied, so asking costs nothing but the prompt.
 */
export const WALLET_SIGN_MIN_TIMEOUT_MS = 30_000;

/**
 * Time a signature must still leave inside the transaction's validity window.
 *
 * After the wallet answers, the transaction can still need the relay account's co-signature and
 * a sponsored fee, each one request through the proxy whose SDK client gives up after 45 s, and
 * then a ledger to include it (about 5 s each, so 10 s allows two closes and some clock skew).
 * A signature that arrives later than this cannot be relied on to land before `maxTime`, so the
 * prompt is not left open past it.
 */
export const SUBMIT_MARGIN_MS = 45_000 + 45_000 + 10_000;

/**
 * How long the wallet may take to sign a transaction valid until `validUntil` (seconds since the
 * epoch, the envelope's `maxTime`), at `now` (ms since the epoch): what the validity window leaves
 * after the margin, kept between 30 s and two minutes. The wallet is always asked. An envelope
 * with no upper bound gets the full two minutes; the close loop refuses to send one anyway.
 */
export function signTimeoutMs(validUntil: number | null, now: number): number {
  if (validUntil === null) return WALLET_SIGN_TIMEOUT_MS;
  const left = validUntil * 1000 - now - SUBMIT_MARGIN_MS;
  return Math.min(WALLET_SIGN_TIMEOUT_MS, Math.max(WALLET_SIGN_MIN_TIMEOUT_MS, left));
}

/** A running timeout: `expired` resolves when it runs out, unless `cancel` was called first. */
export interface SignTimer {
  expired: Promise<void>;
  cancel: () => void;
}

/** Starts a timeout of `ms`. Injected into the wallet signer so tests control the clock. */
export function startSignTimeout(ms: number): SignTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}
