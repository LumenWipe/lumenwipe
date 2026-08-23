import "server-only";
import { Keypair, Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import {
  LumenWipeClient,
  runClose,
  type CloseEngineDeps,
  type CloseTransaction,
  type DecisionAnswer,
  type DecisionPoint,
  type IntentOperation,
} from "@lumenwipe/sdk";
import { verifyDemolishTransaction } from "./verify";

export interface RunDemolishOptions {
  demoKeypair: Keypair;
  sinkPublic: string;
  apiUrl: string;
  apiKey: string;
  onConfirmed?: (txId: string, hash: string, operations: IntentOperation[]) => void;
}

/**
 * The API's `destinationDecisionId` / `DESTINATION_ACK_CHOICE` (see
 * apps/api/src/lib/close-api/decisions.ts). Restated here rather than imported: apps/playground
 * must not import from apps/api, and these are part of the API's wire contract, not its internals.
 */
const destinationDecisionId = (address: string): string => `destination:${address}`;
const DESTINATION_ACK_CHOICE = "i_control_this_address";

/**
 * The disposition every playground asset gets.
 *
 * `convert_to_xlm` is deliberately not used. The demo tokens are playground-issued and the only
 * liquidity they have is the market maker's own self-manufactured offer, so path finding is not
 * dependable and a drifted route fails the round with `quote_drifted`. Returning to the issuer -
 * an account the playground itself controls - is always available, needs no path, and carries no
 * slippage risk.
 */
const ASSET_DISPOSITION_CHOICE = "return_to_issuer";

/**
 * Turns the plan's pending decision points into the answer set `close/transactions` requires.
 *
 * Derived from what the API actually asked for rather than from the mess plan, so it stays correct
 * whichever mode funded the session and never has to know which assets exist. A decision point of
 * a kind the playground has no safe automatic answer for (a claimable balance - the playground
 * never creates one) is deliberately left unanswered: the API then refuses the round with a
 * `needs_decisions` 422 naming it, which is a clean, legible failure rather than a guess about
 * whether a balance should be claimed or forfeited.
 */
export function buildDemolishDecisions(
  decisionPoints: DecisionPoint[],
  sinkPublic: string
): DecisionAnswer[] {
  const answers: DecisionAnswer[] = [
    { id: destinationDecisionId(sinkPublic), choice: DESTINATION_ACK_CHOICE },
  ];
  for (const dp of decisionPoints) {
    // The point's own id already carries the API's `asset:CODE-ISSUER` encoding, so it is echoed
    // back verbatim instead of being re-derived from the subject.
    if (dp.type === "asset_disposition") {
      answers.push({ id: dp.id, choice: ASSET_DISPOSITION_CHOICE });
    }
  }
  return answers;
}

/**
 * Drives the real close engine against the demo account. This is the actual
 * production `apps/api` close/transactions -> submit loop - the playground
 * supplies its own verify (structural check against the fixed sink account)
 * and sign (custodial, with the decrypted demo secret) instead of a browser
 * wallet.
 */
export async function runDemolish(opts: RunDemolishOptions): Promise<void> {
  const client = new LumenWipeClient({
    baseUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    network: "testnet",
  });
  const demoPublic = opts.demoKeypair.publicKey();

  // One advisory read, up front. `close/plan` tolerates an empty `decisions` array - it reports
  // what is unresolved instead of refusing - so this is the bootstrapping call whose answer set
  // every later round reuses. `close/transactions` does NOT tolerate it: an unrecognized
  // destination is a 422 `destination_not_acknowledged`, and a funded trustline with no
  // disposition a 422 `needs_decisions`. The API is stateless per round, so the full set has to
  // travel on every call, not just the first.
  const plan = await client.closePlan({ source: demoPublic, destination: opts.sinkPublic });
  const decisions = buildDemolishDecisions(plan.decisionPoints, opts.sinkPublic);

  const deps: CloseEngineDeps = {
    getTransactions: async () => {
      const res = await client.closeTransactions({
        source: demoPublic,
        destination: opts.sinkPublic,
        decisions,
      });
      return res;
    },
    verify: (tx: CloseTransaction) => {
      verifyDemolishTransaction(tx, { demoPublic, sinkPublic: opts.sinkPublic });
    },
    // The demo account is always single-sig from the master key's point of view:
    // ADD_SIGNER (mess step) only ever adds a co-signer, never raises the master
    // key's own weight requirement below what it already satisfies.
    requiredWeight: () => 1,
    sign: async (_tx, xdr) => {
      const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      if (!(parsed instanceof Transaction)) {
        throw new Error("Unexpected fee-bump transaction from the API");
      }
      parsed.sign(opts.demoKeypair);
      return { xdr: parsed.toEnvelope().toXDR("base64"), weight: 1 };
    },
    submit: async (_tx, xdr) => {
      const res = await client.submit(xdr);
      return res.hash;
    },
    onConfirmed: (tx, hash) => opts.onConfirmed?.(tx.id, hash, tx.intent.operations),
  };

  await runClose(deps);
}
