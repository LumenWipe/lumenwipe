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
  CloseTransactionsRequest,
  DecisionPoint,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/sdk";
import type { DemolishApi, DemolishChain } from "@/lib/demolish";
import type { SignerState } from "@/lib/horizon-submit";
import { PHOENIX } from "@/lib/scenarios";

// A fake ledger for one Phoenix demo, standing in for both the LumenWipe API and the network. It
// builds the close the way the API's Phoenix exit does (apps/api/src/lib/defi-exits/phoenix.ts):
// every stake unbonded first, one call each, then one `withdraw_liquidity` for the plain shares,
// each a transaction of its own with the authorization tree testnet returns for it; then the merge.
// The LWPHX the demo holds is a Soroban token the plan asks about, and the merge is built only once
// it is answered `acknowledge_residue`.

const PASSPHRASE = Networks.TESTNET;
const STAKE_TIMESTAMP = BigInt(1_762_000_000);

/** The plan's question about the demo's LWPHX, as the API asks it. */
export const LWPHX_DECISION: DecisionPoint = {
  id: `token:${PHOENIX.tokenA}`,
  type: "asset_disposition",
  subject: { kind: "soroban_token", contract: PHOENIX.tokenA },
  options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
  default: "transfer_to_account",
  required: true,
} as DecisionPoint;

export class FakePhoenixLedger implements DemolishApi, DemolishChain {
  open = true;
  /** Each confirmed exit, as `contract.function`. */
  readonly exits: string[] = [];
  readonly submitted: string[][] = [];
  /** The LWPHX answer each `close/transactions` call carried. */
  readonly residueAnswers: (string | undefined)[] = [];
  private readonly confirmed = new Set<string>();

  constructor(
    readonly demo: string,
    readonly sink: string,
    /** The demo's plain shares and its stake, as the seeding left them. */
    public shares: bigint,
    public staked: bigint
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
    return { decisionPoints: [LWPHX_DECISION], blockers: [] };
  }

  private exitOp(): xdr.Operation | null {
    const user = new Address(this.demo).toScVal();
    const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
    const fn = (contract: string, name: string, args: xdr.ScVal[]) =>
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: name,
          args,
        })
      );
    const entry = (
      contract: string,
      name: string,
      args: xdr.ScVal[],
      subs: xdr.SorobanAuthorizedInvocation[]
    ): xdr.SorobanAuthorizationEntry =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: fn(contract, name, args),
          subInvocations: subs,
        }),
      });
    if (this.staked > BigInt(0)) {
      const args = [user, i128(this.staked), nativeToScVal(STAKE_TIMESTAMP, { type: "u64" })];
      // The stake pays the shares out of its own balance: nothing below the unbond.
      return Operation.invokeContractFunction({
        contract: PHOENIX.stake,
        function: "unbond",
        args,
        auth: [entry(PHOENIX.stake, "unbond", args, [])],
      });
    }
    if (this.shares > BigInt(0)) {
      // Floors at the position's share of each reserve less the slippage margin, both positive.
      const args = [user, i128(this.shares), i128(BigInt(4_600_000)), i128(BigInt(4_800_000))];
      args.push(xdr.ScVal.scvVoid());
      const moveShares = new xdr.SorobanAuthorizedInvocation({
        function: fn(PHOENIX.shareToken, "transfer", [
          user,
          new Address(PHOENIX.pool).toScVal(),
          i128(this.shares),
        ]),
        subInvocations: [],
      });
      return Operation.invokeContractFunction({
        contract: PHOENIX.pool,
        function: "withdraw_liquidity",
        args,
        auth: [entry(PHOENIX.pool, "withdraw_liquidity", args, [moveShares])],
      });
    }
    return null;
  }

  async closeTransactions(body: CloseTransactionsRequest): Promise<TransactionsResponse> {
    if (!this.open) throw new Error("account_not_found");
    this.residueAnswers.push(body.decisions?.find((d) => d.id === LWPHX_DECISION.id)?.choice);
    const exit = this.exitOp();
    const builder = new TransactionBuilder(new Account(this.demo, "1"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    }).setTimebounds(0, Math.floor(Date.now() / 1000) + 300);
    builder.addOperation(exit ?? Operation.accountMerge({ destination: this.sink }));
    const tx: CloseTransaction = {
      id: exit === null ? "merge" : "phoenix-exit",
      order: 0,
      dependsOn: [],
      xdr: builder.build().toEnvelope().toXdr("base64"),
      networkPassphrase: PASSPHRASE,
      sourceSequence: "1",
      validUntilLedger: 100,
      covers: exit === null ? ["MERGE"] : [],
      intent: {
        summary: exit === null ? "Close the account" : "Leave the Phoenix pool",
        source: this.demo,
        fee: "100",
        memo: null,
        memoType: null,
        guarantees: {
          mergeDestination: exit === null ? this.sink : null,
          paymentsOnlyTo: [],
          minXlmFromConversions: null,
        },
        operations: [],
      },
    };
    const steps = (this.staked > BigInt(0) ? 1 : 0) + (this.shares > BigInt(0) ? 1 : 0);
    return {
      planHash: "plan",
      status: "ready",
      transactions: [tx],
      remaining: { steps, requiresAnotherCall: exit !== null },
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
      const contract = Address.fromScAddress(fn.invokeContract.contractAddress).toString();
      const name = fn.invokeContract.functionName.toString();
      this.exits.push(`${contract === PHOENIX.stake ? "stake" : "pool"}.${name}`);
      if (name === "unbond") {
        this.shares += this.staked;
        this.staked = BigInt(0);
      }
      if (name === "withdraw_liquidity") this.shares = BigInt(0);
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
