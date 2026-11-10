import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  CloseTransaction,
  DecisionPoint,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { DemolishApi, DemolishChain } from "@/lib/demolish";
import type { SignerState } from "@/lib/horizon-submit";
import type { NewSigner } from "@/lib/mess-builders";

// A fake ledger for one multi-signature demo, standing in for both the LumenWipe API and the
// network. It builds the close the way the API does (the other signers removed in a round of their
// own while the master key alone cannot reach the thresholds, then the merge), and it applies a
// submitted envelope only if its signatures meet the threshold the way stellar-core judges them:
// every signature must belong to a live signer (`tx_bad_auth_extra` otherwise) and their weight
// must reach the strictest operation's threshold (`tx_bad_auth` otherwise).

const PASSPHRASE = Networks.TESTNET;

export interface LiveSigner {
  key: string;
  type: "ed25519_public_key" | "hash_x" | "preauth_tx";
  weight: number;
}

export class FakeMultisigLedger implements DemolishApi, DemolishChain {
  open = true;
  signers: LiveSigner[];
  thresholds = { low: 2, med: 2, high: 2 };
  readonly submitted: { hash: string; ops: string[]; refused: string | null }[] = [];
  private readonly confirmed = new Set<string>();

  constructor(
    readonly demo: string,
    readonly sink: string,
    added: Pick<NewSigner, "key" | "type" | "weight">[]
  ) {
    this.signers = [{ key: demo, type: "ed25519_public_key", weight: 1 }, ...added];
  }

  async signerState(): Promise<SignerState> {
    return {
      signers: this.signers.map((s) => ({ ...s })),
      thresholds: { ...this.thresholds },
    };
  }

  async nativeBalance(): Promise<string> {
    throw new Error("This ledger closes into no exchange");
  }

  async ledgerTransaction(): Promise<null> {
    throw new Error("This ledger closes into no exchange");
  }

  async closePlan(): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }> {
    return { decisionPoints: [], blockers: [] };
  }

  private needsNormalization(): boolean {
    return this.signers.length > 1 || this.thresholds.med > 1 || this.thresholds.high > 1;
  }

  async closeTransactions(): Promise<TransactionsResponse> {
    if (!this.open) throw new Error("account_not_found");
    const normalize = this.needsNormalization();
    const builder = new TransactionBuilder(new Account(this.demo, "1"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    }).setTimebounds(0, Math.floor(Date.now() / 1000) + 300);
    if (normalize) {
      for (const s of this.signers.filter((s) => s.key !== this.demo)) {
        builder.addOperation(removalOp(s));
      }
      builder.addOperation(
        Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 })
      );
    } else {
      builder.addOperation(Operation.accountMerge({ destination: this.sink }));
    }
    const tx: CloseTransaction = {
      id: normalize ? "normalize" : "merge",
      order: 0,
      dependsOn: [],
      xdr: builder.build().toEnvelope().toXdr("base64"),
      networkPassphrase: PASSPHRASE,
      sourceSequence: "1",
      validUntilLedger: 100,
      covers: normalize ? ["NORMALIZE_SIGNERS"] : ["MERGE"],
      intent: {
        summary: normalize ? "Remove the other signers" : "Close the account",
        source: this.demo,
        fee: "100",
        memo: null,
        memoType: null,
        guarantees: {
          mergeDestination: normalize ? null : this.sink,
          paymentsOnlyTo: [],
          minXlmFromConversions: null,
        },
        operations: [],
      },
    };
    return {
      planHash: "plan",
      status: "ready",
      transactions: [tx],
      remaining: { steps: normalize ? 1 : 0, requiresAnotherCall: normalize },
    };
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    const tx = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    const txHash = Buffer.from(tx.hash()).toString("hex");
    const refused = this.authorize(tx);
    this.submitted.push({ hash: txHash, ops: tx.operations.map((op) => op.type), refused });
    if (refused) throw new Error(refused);
    for (const op of tx.operations) this.apply(op);
    this.confirmed.add(txHash);
    return { hash: txHash };
  }

  async feeBumpSponsor(): Promise<{ transaction: string }> {
    throw new Error("This ledger pays its own fees");
  }

  async mediatorSign(): Promise<{ transaction: string }> {
    throw new Error("This ledger closes into no exchange");
  }

  async getTransaction(txHash: string): Promise<TransactionLookupResponse> {
    if (this.confirmed.has(txHash)) return { status: "confirmed", hash: txHash, ledger: 10 };
    const now = Math.floor(Date.now() / 1000);
    return {
      status: "not_found",
      hash: txHash,
      searched: {
        oldestLedger: 1,
        oldestLedgerCloseTime: now - 3600,
        latestLedger: 10,
        latestLedgerCloseTime: now,
      },
    };
  }

  /** stellar-core's verdict on the envelope's signatures, or null when they authorize it. */
  private authorize(tx: Transaction): string | null {
    const digest = tx.hash();
    const used = new Set<string>();
    for (const sig of tx.signatures) {
      const hint = Buffer.from(sig.hint.toBytes());
      const bytes = Buffer.from(sig.signature.toBytes());
      const signer = this.signers.find((s) => {
        if (s.type === "ed25519_public_key") {
          const kp = Keypair.fromPublicKey(s.key);
          return hint.equals(kp.signatureHint()) && kp.verify(digest, bytes);
        }
        if (s.type === "hash_x") {
          const h = StrKey.decodeSha256Hash(s.key);
          return hint.equals(h.subarray(h.length - 4)) && Buffer.from(hash(bytes)).equals(h);
        }
        return false;
      });
      if (!signer || used.has(signer.key)) return "tx_bad_auth_extra";
      used.add(signer.key);
    }
    const weight = this.signers
      .filter((s) => used.has(s.key))
      .reduce((sum, s) => sum + s.weight, 0);
    const high = tx.operations.some((op) => op.type === "setOptions" || op.type === "accountMerge");
    return weight >= Math.max(1, high ? this.thresholds.high : this.thresholds.med)
      ? null
      : "tx_bad_auth";
  }

  private apply(op: Transaction["operations"][number]): void {
    if (op.type === "accountMerge") {
      this.open = false;
      return;
    }
    if (op.type !== "setOptions") return;
    if (op.signer) {
      const key = signerKey(op.signer);
      this.signers = this.signers.filter((s) => s.key !== key);
    }
    if (op.lowThreshold !== undefined) this.thresholds.low = op.lowThreshold;
    if (op.medThreshold !== undefined) this.thresholds.med = op.medThreshold;
    if (op.highThreshold !== undefined) this.thresholds.high = op.highThreshold;
  }
}

export function removalOp(s: Pick<LiveSigner, "key" | "type">): xdr.Operation {
  if (s.type === "hash_x") {
    return Operation.setOptions({
      signer: { sha256Hash: StrKey.decodeSha256Hash(s.key), weight: 0 },
    });
  }
  if (s.type === "preauth_tx") {
    return Operation.setOptions({
      signer: { preAuthTx: StrKey.decodePreAuthTx(s.key), weight: 0 },
    });
  }
  return Operation.setOptions({ signer: { ed25519PublicKey: s.key, weight: 0 } });
}

function signerKey(signer: object): string {
  if ("ed25519PublicKey" in signer && typeof signer.ed25519PublicKey === "string") {
    return signer.ed25519PublicKey;
  }
  if ("sha256Hash" in signer && signer.sha256Hash instanceof Uint8Array) {
    return StrKey.encodeSha256Hash(Buffer.from(signer.sha256Hash));
  }
  if ("preAuthTx" in signer && signer.preAuthTx instanceof Uint8Array) {
    return StrKey.encodePreAuthTx(Buffer.from(signer.preAuthTx));
  }
  throw new Error("unknown signer");
}
