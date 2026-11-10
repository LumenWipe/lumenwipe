import {
  Account,
  Address,
  nativeToScVal,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
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
import { BLEND, BLEND_REQUEST } from "@/lib/scenarios";

// A fake ledger for one Blend demo, standing in for both the LumenWipe API and the network. It
// builds the close the way the API's Blend exit does (apps/api/src/lib/defi-exits/blend.ts): one
// `submit` per step, the repay first while there is a debt, then the collateral's withdrawal, each
// a transaction of its own and each with the authorization tree testnet returns for it; then the
// merge. A submitted step clears what it exits, so each round sees the position the last one left.

const PASSPHRASE = Networks.TESTNET;

/** What a step asks for: the debt plus a margin, or the collateral plus one. */
const REPAY_AMOUNT = BigInt(20_020_000);
const WITHDRAW_AMOUNT = BigInt(200_200_000);

export class FakeBlendLedger implements DemolishApi, DemolishChain {
  open = true;
  /** The Blend request type each confirmed exit made, in order. */
  readonly exits: number[] = [];
  readonly submitted: string[][] = [];
  private readonly confirmed = new Set<string>();

  constructor(
    readonly demo: string,
    readonly sink: string,
    public debt: boolean,
    public collateral = true
  ) {}

  async signerState(): Promise<SignerState> {
    return {
      signers: [{ key: this.demo, type: "ed25519_public_key", weight: 1 }],
      thresholds: { low: 0, med: 0, high: 0 },
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

  private submitOp(type: number): xdr.Operation {
    const user = new Address(this.demo).toScVal();
    const amount = type === BLEND_REQUEST.repay ? REPAY_AMOUNT : WITHDRAW_AMOUNT;
    const request = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("address"),
        val: new Address(BLEND.reserve).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: nativeToScVal(amount, { type: "i128" }),
      }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: xdr.ScVal.scvU32(type) }),
    ]);
    const args = [user, user, user, xdr.ScVal.scvVec([request])];
    const call = (contract: string, fn: string, callArgs: xdr.ScVal[]) =>
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args: callArgs,
        })
      );
    // A repay moves the demo's XLM into the pool under the demo's authority; a withdrawal is paid
    // out by the pool and authorizes nothing below the submit.
    const subInvocations =
      type === BLEND_REQUEST.repay
        ? [
            new xdr.SorobanAuthorizedInvocation({
              function: call(BLEND.reserve, "transfer", [
                user,
                new Address(BLEND.pool).toScVal(),
                nativeToScVal(amount, { type: "i128" }),
              ]),
              subInvocations: [],
            }),
          ]
        : [];
    return Operation.invokeContractFunction({
      contract: BLEND.pool,
      function: "submit",
      args,
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: call(BLEND.pool, "submit", args),
            subInvocations,
          }),
        }),
      ],
    });
  }

  async closeTransactions(): Promise<TransactionsResponse> {
    if (!this.open) throw new Error("account_not_found");
    const step = this.debt
      ? BLEND_REQUEST.repay
      : this.collateral
        ? BLEND_REQUEST.withdrawCollateral
        : null;
    const builder = new TransactionBuilder(new Account(this.demo, "1"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    }).setTimebounds(0, Math.floor(Date.now() / 1000) + 300);
    builder.addOperation(
      step === null ? Operation.accountMerge({ destination: this.sink }) : this.submitOp(step)
    );
    const tx: CloseTransaction = {
      id: step === null ? "merge" : `blend-${step}`,
      order: 0,
      dependsOn: [],
      xdr: builder.build().toEnvelope().toXdr("base64"),
      networkPassphrase: PASSPHRASE,
      sourceSequence: "1",
      validUntilLedger: 100,
      covers: step === null ? ["MERGE"] : [],
      intent: {
        summary: step === null ? "Close the account" : "Leave the Blend pool",
        source: this.demo,
        fee: "100",
        memo: null,
        memoType: null,
        guarantees: {
          mergeDestination: step === null ? this.sink : null,
          paymentsOnlyTo: [],
          minXlmFromConversions: null,
        },
        operations: [],
      },
    };
    const steps = (this.debt ? 1 : 0) + (this.collateral ? 1 : 0);
    return {
      planHash: "plan",
      status: "ready",
      transactions: [tx],
      remaining: { steps, requiresAnotherCall: step !== null },
    };
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    const tx = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    const txHash = Buffer.from(tx.hash()).toString("hex");
    this.submitted.push(tx.operations.map((op) => op.type));
    for (const op of tx.operations) {
      if (op.type === "accountMerge") this.open = false;
      if (op.type !== "invokeHostFunction") continue;
      const fn = op.func;
      if (fn.type !== "hostFunctionTypeInvokeContract") continue;
      const list = fn.invokeContract.args[3];
      for (const request of list?.type === "scvVec" ? (list.vec ?? []) : []) {
        const entries = request.type === "scvMap" ? (request.map ?? []) : [];
        const field = entries.find(
          (e) => e.key.type === "scvSymbol" && e.key.sym.toString() === "request_type"
        )?.val;
        const type = field?.type === "scvU32" ? field.u32 : -1;
        this.exits.push(type);
        if (type === BLEND_REQUEST.repay) this.debt = false;
        if (type === BLEND_REQUEST.withdrawCollateral) {
          // The pool refuses to release collateral that still backs a debt.
          if (this.debt) throw new Error("health_factor_too_low");
          this.collateral = false;
        }
      }
    }
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
}
