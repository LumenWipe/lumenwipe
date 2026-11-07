"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCloseDelivered } from "@/lib/api/delivered-client";
import { closingHashes, readReceived } from "@/lib/receipt/received";
import { updateHistory } from "@/lib/session/history";
import type { ReceiptRecord } from "@/types/history";

/** What the receipt can say about the XLM the destination received. */
export type ReceivedState =
  | { state: "recorded"; lumens: string }
  /** Nothing to look up: the merge did not confirm, or its hash was not kept. */
  | { state: "none" }
  | { state: "loading" }
  /** The ledger's answer did not establish an amount. */
  | { state: "unavailable"; hashes: string[] }
  /** The lookup itself failed; it can be asked again. */
  | { state: "failed"; hashes: string[] };

interface Options {
  /** False until the record may be looked up, as while its save is still pending. */
  enabled: boolean;
  /** Write a found amount into the saved receipt, so a reopened one never asks again. */
  persist: boolean;
}

type Answer = { key: string } & (
  { kind: "received"; lumens: string } | { kind: "unavailable" } | { kind: "failed" }
);

/**
 * The amount a closed receipt records, or a lookup of it from the ledger when it records none.
 * Asks at most once per mount and receipt: only `retry` asks again. Display only: the amount
 * feeds no check and no signature.
 */
export function useReceivedLumens(
  record: ReceiptRecord | null,
  { enabled, persist }: Options
): { received: ReceivedState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const asked = useRef<string | null>(null);

  const hashes = record ? closingHashes(record) : null;
  const key = record && hashes ? `${record.id}:${attempt}` : null;
  const recorded = record?.receivedLumens ?? null;

  const network = record?.network;
  const id = record?.id;
  const destination = record?.destinationAddress;
  const hashList = hashes?.join(",");

  useEffect(() => {
    if (!enabled || recorded !== null || key === null || asked.current === key) return;
    if (!network || !id || !destination || !hashList) return;
    asked.current = key;
    const ask = hashList.split(",");
    fetchCloseDelivered(network, destination, ask).then(
      (response) => {
        const lumens = readReceived(response, { destination, hashes: ask });
        if (lumens !== null && persist) {
          updateHistory(id, { receivedLumens: lumens }).catch((err: unknown) =>
            console.error("[receipt] amount save failed:", err)
          );
        }
        setAnswer(
          lumens === null ? { key, kind: "unavailable" } : { key, kind: "received", lumens }
        );
      },
      (err: unknown) => {
        console.error("[receipt] amount lookup failed:", err);
        setAnswer({ key, kind: "failed" });
      }
    );
  }, [enabled, persist, recorded, key, network, id, destination, hashList]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let received: ReceivedState;
  if (recorded !== null) received = { state: "recorded", lumens: recorded };
  else if (answer?.kind === "received" && answer.key.startsWith(`${id}:`)) {
    received = { state: "recorded", lumens: answer.lumens };
  } else if (!hashes || key === null) received = { state: "none" };
  else if (answer?.key !== key) received = { state: "loading" };
  else received = { state: answer.kind === "failed" ? "failed" : "unavailable", hashes };

  return { received, retry };
}
