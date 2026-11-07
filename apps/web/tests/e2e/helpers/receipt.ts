import { expect, type Page } from "@playwright/test";
import type { ReceiptRecord } from "../../../types/history";
import { RECORD_VERSION } from "../../../types/session";
import { dismissRiskModal } from "./flow";

const MERGE_HASH = "5f".repeat(32);
const OFFERS_HASH = "a1".repeat(32);

/** A closed receipt as this browser saves one, with its amount already recorded so opening it
 *  asks no API. The addresses are valid keys; nothing here reaches the network. */
export function closedReceipt(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "e2e-receipt",
    network: "testnet",
    sourceAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    destinationAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    memo: { text: "4242", type: "id" },
    transactions: [
      {
        txHash: OFFERS_HASH,
        label: "Cancel offers",
        stepTypes: ["CANCEL_OFFERS"],
        stepTitles: ["Cancel offers"],
      },
      { txHash: MERGE_HASH, label: "Merge", stepTypes: ["MERGE"], stepTitles: ["Merge"] },
    ],
    groups: [
      {
        type: "CANCEL_OFFERS",
        title: "Offers cancelled",
        summary: "1 open offer",
        items: [{ text: "10 USDC → XLM" }],
      },
      {
        type: "HANDLE_ASSETS",
        title: "Assets handled",
        summary: "1 asset with a balance",
        items: [{ text: "USDC → swapped to XLM" }],
      },
    ],
    feeLumens: "0.0000200",
    receivedLumens: "1234.5000000",
    ...over,
  };
}

/** Puts a receipt into this browser's history the way the app keeps it, and opens it. The first
 *  visit lets the app create its own database, so the record lands in the schema it reads. */
export async function openSeededReceipt(page: Page, record: ReceiptRecord): Promise<void> {
  await page.goto(`/${record.network}/receipt/${record.id}`);
  await dismissRiskModal(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Receipt not found in this browser"
  );
  await page.evaluate(
    (entry) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("lumenwipe");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("history", "readwrite");
          tx.objectStore("history").put(entry);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    record
  );
  await page.reload();
  await dismissRiskModal(page);
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
    "Receipt not found in this browser"
  );
}
