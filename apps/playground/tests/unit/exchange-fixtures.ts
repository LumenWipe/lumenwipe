import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  LumenWipeApiError,
  type CloseTransaction,
  type CloseTransactionsRequest,
  type DecisionPoint,
  type TransactionLookupResponse,
  type TransactionsResponse,
} from "@lumenwipe/sdk";
import type { DemolishApi, DemolishChain } from "@/lib/demolish";
import type { SignerState } from "@/lib/horizon-submit";
import { formatStroops, parseStroops } from "@/lib/stroops";
import type { LedgerTransaction } from "@/lib/verify-mediator";

// A fake LumenWipe API with a mediator, and the network beside it, for an exchange close: the API
// builds the cleanup round and then the relay hand-off as apps/api does (the forward is the
// balance less the two-operation fee), its mediator co-signs with the relay key or tampers with
// the envelope as a test asks, and the network records what landed and reports it back by hash.
// Keys come from the test.

const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = BigInt(100);

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const hashOf = (xdr: string): string =>
  hex(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash());

/** An upper time bound five minutes from the (possibly fixed) clock. */
const maxTime = (): number => Math.floor(Date.now() / 1000) + 300;

const stroops = (amount: string): bigint => {
  const value = parseStroops(amount);
  if (value === null) throw new Error(`unreadable amount ${amount}`);
  return value;
};

function closeTransaction(
  id: string,
  xdr: string,
  covers: string[],
  demo: string,
  destination: string | null
): CloseTransaction {
  return {
    id,
    order: 0,
    dependsOn: [],
    xdr,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers,
    intent: {
      summary: id,
      source: demo,
      fee: "200",
      memo: null,
      memoType: null,
      guarantees: {
        mergeDestination: destination,
        paymentsOnlyTo: [],
        minXlmFromConversions: null,
      },
      operations: [],
    },
  } as CloseTransaction;
}

/** How the mediator answers a sign request. */
export type Cosign = "sign" | "change-hash" | "drop-signature" | "other-key" | "two-signatures";

/** What the network reports for a hash: what was sent, or a tampered or missing record. */
export type LedgerView = "as-sent" | "wrong-memo" | "text-memo" | "short" | "failed";

export class FakeExchangeApi implements DemolishApi, DemolishChain {
  /** The demo's balance on the network, in stroops. */
  balance: bigint;
  dataEntries: number;
  /** The balance the API believes the demo holds, when it differs from the network's. */
  apiBalance: bigint | null = null;
  cosign: Cosign = "sign";
  ledger: LedgerView = "as-sent";
  /** Reads by hash that answer "not found" before the network reports the transaction. */
  lagReads = 0;
  /** A submission lands but its answer is lost, until the API's lookup sees it. */
  landSilently = false;
  lookupSeesLanded = true;
  readonly requests: CloseTransactionsRequest[] = [];
  readonly submitted: string[] = [];
  readonly signRequests: string[] = [];
  readonly landed = new Map<string, string>();
  readonly ledgerReads: string[] = [];

  constructor(
    private readonly demo: Keypair,
    private readonly relay: Keypair,
    private readonly standIn: string,
    { balance = "30.0000000", dataEntries = 1 }: { balance?: string; dataEntries?: number } = {}
  ) {
    this.balance = stroops(balance);
    this.dataEntries = dataEntries;
  }

  async closePlan(): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }> {
    return { decisionPoints: [], blockers: [] };
  }

  private builder(): TransactionBuilder {
    return new TransactionBuilder(new Account(this.demo.publicKey(), "1"), {
      fee: "200",
      networkPassphrase: PASSPHRASE,
    }).setTimebounds(0, maxTime());
  }

  async closeTransactions(body: CloseTransactionsRequest): Promise<TransactionsResponse> {
    this.requests.push(body);
    if (this.dataEntries > 0) {
      const builder = this.builder();
      for (let i = 0; i < this.dataEntries; i++) {
        builder.addOperation(Operation.manageData({ name: `junk_${i}`, value: null }));
      }
      const xdr = builder.build().toEnvelope().toXdr("base64");
      return {
        planHash: "plan",
        status: "ready",
        transactions: [
          closeTransaction("cleanup", xdr, ["REMOVE_DATA_ENTRIES"], this.demo.publicKey(), null),
        ],
        remaining: { steps: 1, requiresAnotherCall: true },
      } as TransactionsResponse;
    }
    const forward = (this.apiBalance ?? this.balance) - BigInt(2) * BASE_FEE;
    const xdr = this.builder()
      .addMemo(Memo.id(body.memo ?? "0"))
      .addOperation(Operation.accountMerge({ destination: this.relay.publicKey() }))
      .addOperation(
        Operation.payment({
          source: this.relay.publicKey(),
          destination: body.destination,
          asset: Asset.native(),
          amount: formatStroops(forward),
        })
      )
      .build()
      .toEnvelope()
      .toXdr("base64");
    return {
      planHash: "plan",
      status: "ready",
      transactions: [
        closeTransaction("hand-off", xdr, ["MERGE"], this.demo.publicKey(), this.relay.publicKey()),
      ],
      remaining: { steps: 0, requiresAnotherCall: false },
    } as TransactionsResponse;
  }

  async mediatorSign(signedXdr: string): Promise<{ transaction: string }> {
    this.signRequests.push(signedXdr);
    const tx = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    if (this.cosign === "change-hash") {
      // Another forward, to the same stand-in, signed by the relay alone.
      const other = this.builder()
        .addMemo(tx.memo)
        .addOperation(Operation.accountMerge({ destination: this.relay.publicKey() }))
        .addOperation(
          Operation.payment({
            source: this.relay.publicKey(),
            destination: this.standIn,
            asset: Asset.native(),
            amount: "0.0000001",
          })
        )
        .build();
      other.sign(this.demo);
      other.sign(this.relay);
      return { transaction: other.toEnvelope().toXdr("base64") };
    }
    if (this.cosign === "drop-signature") tx.signatures.splice(0);
    tx.sign(this.cosign === "other-key" ? Keypair.random() : this.relay);
    if (this.cosign === "two-signatures") tx.sign(Keypair.random());
    return { transaction: tx.toEnvelope().toXdr("base64") };
  }

  async feeBumpSponsor(): Promise<{ transaction: string }> {
    throw new Error("An exchange close pays its own fee");
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    this.submitted.push(signedXdr);
    const hash = hashOf(signedXdr);
    const tx = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    this.balance -= BigInt(tx.fee);
    if (tx.operations.some((op) => op.type === "accountMerge")) this.balance = BigInt(0);
    else this.dataEntries = 0;
    this.landed.set(hash, signedXdr);
    if (this.landSilently) {
      throw new LumenWipeApiError(504, { error: { code: "upstream_timeout", message: "fake" } });
    }
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

  async signerState(): Promise<SignerState> {
    return {
      signers: [{ key: this.demo.publicKey(), type: "ed25519_public_key", weight: 1 }],
      thresholds: { low: 0, med: 0, high: 0 },
    };
  }

  async nativeBalance(): Promise<string> {
    return formatStroops(this.balance);
  }

  async ledgerTransaction(hash: string): Promise<LedgerTransaction | null> {
    this.ledgerReads.push(hash);
    if (this.lagReads > 0) {
      this.lagReads--;
      return null;
    }
    const sent = this.landed.get(hash);
    if (!sent) return null;
    if (this.ledger === "as-sent") return { successful: true, envelopeXdr: sent };
    if (this.ledger === "failed") return { successful: false, envelopeXdr: sent };
    // The record the network reports for the hash, rewritten as the test asks.
    const tx = TransactionBuilder.fromXdr(sent, PASSPHRASE) as Transaction;
    const forward = tx.operations[1];
    const amount = forward?.type === "payment" ? forward.amount : "0";
    const memo =
      this.ledger === "wrong-memo"
        ? Memo.id("1")
        : this.ledger === "text-memo"
          ? Memo.text(String(tx.memo.value))
          : tx.memo;
    const rewritten = this.builder()
      .addMemo(memo)
      .addOperation(Operation.accountMerge({ destination: this.relay.publicKey() }))
      .addOperation(
        Operation.payment({
          source: this.relay.publicKey(),
          destination: this.standIn,
          asset: Asset.native(),
          amount: this.ledger === "short" ? "0.0000001" : amount,
        })
      )
      .build();
    return { successful: true, envelopeXdr: rewritten.toEnvelope().toXdr("base64") };
  }
}
