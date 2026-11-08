import {
  runClose,
  type AccountState,
  type CloseTransaction,
  type DecisionAnswer,
  type DecisionPoint,
  type LumenWipeClient,
} from "@lumenwipe/sdk";
import {
  assertConfirmed,
  assertMatchesLedger,
  assertDestinationAllowed,
  assertUnderBalanceCap,
  confirmationPhrase,
  masterWeight,
  type LedgerAccount,
} from "./guards";
import { LabRefusal } from "./home";
import type { Network } from "./scenarios";

export type CloseApi = Pick<
  LumenWipeClient,
  "getAccount" | "closePlan" | "closeTransactions" | "submit"
>;

export interface LabSigner {
  publicKey: string;
  /** The envelope signed with the lab key. */
  sign(xdr: string): string;
  /** The transaction hash, computed locally over the network passphrase. */
  hash(xdr: string): string;
}

export interface E2eDeps {
  network: Network;
  submit: boolean;
  destination: string | undefined;
  allowlist: readonly string[];
  capXlm: string;
  signer: LabSigner;
  api: CloseApi;
  /** The source as Horizon reads it, never from the API under test; null when the account does
   *  not exist. */
  horizonAccount: (address: string) => Promise<LedgerAccount | null>;
  verify: (tx: CloseTransaction, account: AccountState, destination: string) => void;
  /** Asks the person at the terminal; null when nothing was typed. */
  prompt: (question: string) => Promise<string | null>;
  isTTY: boolean;
  closeRunner?: typeof runClose;
  now?: () => number;
  log?: (line: string) => void;
}

export interface E2eStep {
  step: string;
  ms: number;
}

export interface E2eReport {
  network: Network;
  submitted: boolean;
  steps: E2eStep[];
}

const DESTINATION_ACK_CHOICE = "i_control_this_address";

/** Acknowledges the destination when the plan asks. Any other required decision is a choice
 *  about the account's assets, so the run stops instead of guessing. */
export function labDecisions(points: DecisionPoint[], destination: string): DecisionAnswer[] {
  const id = `destination:${destination}`;
  const unresolved = points.filter((p) => p.required && p.id !== id);
  if (unresolved.length > 0) {
    throw new LabRefusal(
      `the plan needs decisions the lab does not make: ${unresolved.map((p) => p.id).join(", ")}`
    );
  }
  return points.some((p) => p.id === id) ? [{ id, choice: DESTINATION_ACK_CHOICE }] : [];
}

export async function runE2e(deps: E2eDeps): Promise<E2eReport> {
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? (() => {});
  const source = deps.signer.publicKey;
  const steps: E2eStep[] = [];
  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const start = now();
    try {
      return await fn();
    } finally {
      steps.push({ step, ms: Math.round(now() - start) });
    }
  };

  const destination = assertDestinationAllowed(deps.destination, source, deps.allowlist);
  const ledger = await deps.horizonAccount(source);
  if (ledger === null) throw new LabRefusal("the source account does not exist on this network");
  assertUnderBalanceCap(ledger.nativeBalance, deps.capXlm);
  const weight = masterWeight({ address: source, ...ledger });

  const account = await timed("analyze", () => deps.api.getAccount(source, deps.network));
  assertMatchesLedger(account, ledger);
  const plan = await timed("plan", () => deps.api.closePlan({ source, destination }, deps.network));
  if (plan.blockers.length > 0) {
    throw new LabRefusal(`the plan is blocked: ${plan.blockers.map((b) => b.code).join(", ")}`);
  }
  const decisions = labDecisions(plan.decisionPoints, destination);

  if (!deps.submit) {
    const round = await timed("build round 1", () =>
      deps.api.closeTransactions({ source, destination, decisions }, deps.network)
    );
    for (const tx of round.transactions) deps.verify(tx, account, destination);
    log(`dry run: ${round.transactions.length} transaction(s) built and verified, none signed`);
    return { network: deps.network, submitted: false, steps };
  }

  const typed = deps.isTTY
    ? await deps.prompt(
        `This closes ${source} on ${deps.network} into ${destination}. It cannot be undone. Type "${confirmationPhrase(source)}" to continue: `
      )
    : null;
  assertConfirmed(typed, source, deps.isTTY);

  let round = 0;
  let submittedAt = 0;
  await (deps.closeRunner ?? runClose)({
    getTransactions: (request) => {
      round += 1;
      return timed(`build round ${round}`, () =>
        deps.api.closeTransactions(
          {
            source,
            destination,
            decisions,
            ...(request.planHash && { planHash: request.planHash }),
          },
          deps.network
        )
      );
    },
    planHash: plan.planHash,
    verify: (tx) => deps.verify(tx, account, destination),
    requiredWeight: () => Math.max(1, account.thresholds.high),
    transactionHash: (xdr) => deps.signer.hash(xdr),
    sign: async (_tx, xdr) => ({ xdr: deps.signer.sign(xdr), weight }),
    submit: async (_tx, xdr) => {
      submittedAt = now();
      return (await deps.api.submit(xdr, deps.network)).hash;
    },
    onConfirmed: (tx) => {
      steps.push({ step: `confirm ${tx.id}`, ms: Math.round(now() - submittedAt) });
    },
    onProgress: log,
  });

  if ((await deps.horizonAccount(source)) !== null) {
    throw new Error("the close reported success but the source account still exists");
  }
  return { network: deps.network, submitted: true, steps };
}
