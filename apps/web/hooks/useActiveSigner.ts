"use client";

import { useCallback, useRef, useState } from "react";
import type { TransactionSigner } from "@/lib/stellar/signer";

export type SignerKind = "wallet" | "secret-key" | "hash-x";

/**
 * The signer the screen names. `id` is its key as the account lists it. It never carries the
 * signer itself: a secret-key signer holds a keypair and a hash(x) signer holds its preimage.
 * Held in a ref instead, the signer stays out of state snapshots, serialized state and
 * error-boundary dumps. A ref does not hide it from React DevTools, which can inspect refs too.
 */
export type ActiveSigner = { kind: "none" } | { kind: SignerKind; id: string };

export const NO_SIGNER: ActiveSigner = { kind: "none" };

interface HeldSigner {
  kind: SignerKind;
  signer: TransactionSigner;
}

export interface ActiveSignerControl {
  active: ActiveSigner;
  /** Makes `signer` the one signer: the one held before is dropped, whatever its kind. */
  select: (kind: SignerKind, signer: TransactionSigner) => void;
  /** Drops the signer. */
  clear: () => void;
  /** Drops the signer with a fresh `none`, so effects that read `active` run again even when it
   *  was already none in the render this started from. */
  endTurn: () => void;
  /** Drops the signer only when it is of `kind`. */
  clearKind: (kind: SignerKind) => void;
  /** The signer held, for event handlers and effects only, never for rendering. It is null when
   *  the screen names none, and otherwise the signer whose key the screen names. */
  current: () => HeldSigner | null;
}

/**
 * The one signer `execute()` uses, kept out of React state. The state carries what the screen
 * shows (kind and key), and the signer object sits in a ref that every way of dropping the signer
 * empties together with that state, so the two never disagree. See `ActiveSigner` for what the
 * ref does and does not keep the signer away from.
 */
export function useActiveSigner(): ActiveSignerControl {
  const [active, setActive] = useState<ActiveSigner>(NO_SIGNER);
  const held = useRef<HeldSigner | null>(null);

  const select = useCallback((kind: SignerKind, signer: TransactionSigner) => {
    held.current = { kind, signer };
    setActive({ kind, id: signer.publicKey });
  }, []);

  const clear = useCallback(() => {
    held.current = null;
    setActive(NO_SIGNER);
  }, []);

  const endTurn = useCallback(() => {
    held.current = null;
    setActive({ kind: "none" });
  }, []);

  const clearKind = useCallback((kind: SignerKind) => {
    if (held.current?.kind !== kind) return;
    held.current = null;
    setActive(NO_SIGNER);
  }, []);

  const current = useCallback(() => held.current, []);

  return { active, select, clear, endTurn, clearKind, current };
}
