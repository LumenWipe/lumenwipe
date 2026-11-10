import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  LumenWipeApiError,
  type CloseTransaction,
  type DecisionPoint,
  type TransactionLookupResponse,
  type TransactionsResponse,
} from "@lumenwipe/sdk";
import type { DemolishApi } from "@/lib/demolish";

// A fake LumenWipe API with a fee sponsor that builds and signs real fee-bump envelopes, or tampers
// with them as a test asks, and a network that records what landed. Keys come from the test.

const PASSPHRASE = Networks.TESTNET;

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const hashOf = (xdr: string): string =>
  hex(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash());

export function apiError(status: number, code: string): LumenWipeApiError {
  return new LumenWipeApiError(status, { error: { code, message: "fake" } });
}

export const MAX_TIME = Math.floor(Date.now() / 1000) + 300;

/** The close the API builds: the data entry's removal and the merge into `destination`, at `fee`. */
function closeTransaction(fee: string, demo: string, destination: string): CloseTransaction {
  const xdr = new TransactionBuilder(new Account(demo, "1"), {
    fee,
    networkPassphrase: PASSPHRASE,
  })
    .setTimebounds(0, MAX_TIME)
    .addOperation(Operation.manageData({ name: "promo_code", value: null }))
    .addOperation(Operation.accountMerge({ destination }))
    .build()
    .toEnvelope()
    .toXdr("base64");
  return {
    id: "close-1",
    order: 0,
    dependsOn: [],
    xdr,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: ["REMOVE_DATA_ENTRIES", "MERGE"],
    ...(fee === "0" && { needsSponsoredFee: true }),
    intent: {
      summary: "Remove 1 data entry and close the account",
      source: demo,
      fee,
      memo: null,
      memoType: null,
      guarantees: {
        mergeDestination: destination,
        paymentsOnlyTo: [],
        minXlmFromConversions: null,
      },
      operations: [],
    },
  };
}

type Sponsor = "sign" | "refuse" | "other-source" | "drop-signature" | "unsigned";

/** The API, its fee sponsor and the network, for a demo closing into `sink`. */
export class FakeSponsoredApi implements DemolishApi {
  fee = "0";
  destination: string;
  sponsor: Sponsor = "sign";
  closeError: LumenWipeApiError | null = null;
  landSilently = false;
  lookupSeesLanded = false;
  readonly landed = new Set<string>();
  readonly sponsored: string[] = [];
  readonly submitted: string[] = [];
  calls = { sponsor: 0, transactions: 0 };

  constructor(
    private readonly demo: string,
    sink: string,
    private readonly feeAccount: Keypair
  ) {
    this.destination = sink;
  }

  async closePlan(): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }> {
    return { decisionPoints: [], blockers: [] };
  }

  async closeTransactions(): Promise<TransactionsResponse> {
    this.calls.transactions++;
    if (this.closeError) throw this.closeError;
    return {
      planHash: "plan",
      status: "ready",
      transactions: [closeTransaction(this.fee, this.demo, this.destination)],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  }

  async feeBumpSponsor(signedXdr: string): Promise<{ transaction: string }> {
    this.calls.sponsor++;
    this.sponsored.push(signedXdr);
    if (this.sponsor === "refuse") throw apiError(429, "sponsorship_budget_exhausted");
    const inner = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    if (this.sponsor === "drop-signature") inner.signatures.splice(0);
    const other = Keypair.random();
    const source = this.sponsor === "other-source" ? other : this.feeAccount;
    const wrapped = TransactionBuilder.buildFeeBumpTransaction(source, "100", inner, PASSPHRASE);
    if (this.sponsor !== "unsigned") wrapped.sign(source);
    return { transaction: wrapped.toEnvelope().toXdr("base64") };
  }

  async mediatorSign(): Promise<{ transaction: string }> {
    throw new Error("This API closes into no exchange");
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    this.submitted.push(signedXdr);
    const hash = hashOf(signedXdr);
    this.landed.add(hash);
    if (this.landSilently) throw apiError(504, "upstream_timeout");
    return { hash };
  }

  async getTransaction(hash: string): Promise<TransactionLookupResponse> {
    if (this.lookupSeesLanded && this.landed.has(hash)) {
      return { status: "confirmed", hash, ledger: 10 };
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      status: "not_found",
      hash,
      searched: {
        oldestLedger: 1,
        oldestLedgerCloseTime: now - 3600,
        latestLedger: 10,
        latestLedgerCloseTime: now,
      },
    };
  }
}
