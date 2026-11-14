"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One close transaction's receipt as /api/receipt answers it (lib/receipt.ts `TxReceipt`). */
export type ClientReceipt =
  | {
      hash: string;
      status: "read";
      feeStroops: string;
      feePaidBy: "account" | "sponsor";
      operations: { type: string; count: number }[];
      merge:
        | { into: "destination"; amountStroops: string; destination: string }
        | {
            into: "relay";
            amountStroops: string;
            forwarded: { amountStroops: string; to: string; memo: string | null };
          }
        | null;
    }
  | { hash: string; status: "failed"; feeStroops: string; feePaidBy: "account" | "sponsor" }
  | { hash: string; status: "pending" | "unavailable" | "loading" };

/** Reads of a hash before the panel stops and offers a retry: Horizon trails a confirmation. */
export const RECEIPT_READ_ATTEMPTS = 6;
export const RECEIPT_READ_DELAY_MS = 2_000;

const STROOPS = /^\d+$/;

function parse(hash: string, body: unknown): ClientReceipt {
  const unavailable: ClientReceipt = { hash, status: "unavailable" };
  if (typeof body !== "object" || body === null) return unavailable;
  const r = body as Record<string, unknown>;
  if (r.hash !== hash) return unavailable;
  if (r.status === "pending") return { hash, status: "pending" };
  if (r.status !== "read" && r.status !== "failed") return unavailable;
  if (typeof r.feeStroops !== "string" || !STROOPS.test(r.feeStroops)) return unavailable;
  if (r.feePaidBy !== "account" && r.feePaidBy !== "sponsor") return unavailable;
  if (r.status === "failed") {
    return { hash, status: "failed", feeStroops: r.feeStroops, feePaidBy: r.feePaidBy };
  }
  return body as ClientReceipt;
}

/** Whether a receipt is settled: read from the ledger, or read as failed there. */
export const isSettled = (r: ClientReceipt): boolean =>
  r.status === "read" || r.status === "failed";

/** A close transaction to read: the account it closed and its hash. */
export interface ReceiptRef {
  account: string;
  hash: string;
}

/**
 * Reads the receipt of each transaction, retrying one that is not readable yet a few times before
 * it waits for `retry`. Never estimates: a transaction that cannot be read stays unread.
 */
export function useReceipts(refs: readonly ReceiptRef[]): {
  receipts: ClientReceipt[];
  retry: () => void;
} {
  const refKey = refs.map((r) => `${r.account}:${r.hash}`).join(",");
  const [found, setFound] = useState<ReadonlyMap<string, ClientReceipt>>(new Map());
  const settled = useRef(new Set<string>());
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!refKey) return;
    let live = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const put = (id: string, receipt: ClientReceipt): void => {
      if (!live) return;
      if (isSettled(receipt)) settled.current.add(id);
      setFound((prev) => new Map(prev).set(id, receipt));
    };
    const read = async (id: string, account: string, hash: string, attempt: number) => {
      let receipt: ClientReceipt;
      try {
        const query = new URLSearchParams({ account, hash });
        const res = await fetch(`/api/receipt?${query.toString()}`);
        receipt = res.ok ? parse(hash, await res.json()) : { hash, status: "unavailable" };
      } catch {
        receipt = { hash, status: "unavailable" };
      }
      if (!live) return;
      if (isSettled(receipt) || attempt + 1 >= RECEIPT_READ_ATTEMPTS) {
        put(id, receipt);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        void read(id, account, hash, attempt + 1);
      }, RECEIPT_READ_DELAY_MS);
      timers.add(timer);
    };
    for (const id of refKey.split(",")) {
      if (settled.current.has(id)) continue;
      const [account = "", hash = ""] = id.split(":");
      put(id, { hash, status: "loading" });
      void read(id, account, hash, 0);
    }
    return () => {
      live = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [refKey, round]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  const receipts = refs.map(
    (r): ClientReceipt => found.get(`${r.account}:${r.hash}`) ?? { hash: r.hash, status: "loading" }
  );
  return { receipts, retry };
}
