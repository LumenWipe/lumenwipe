import { Asset } from "@stellar/stellar-sdk";
import { readLiveTrustline, LiveReadError } from "@/lib/stellar/live-trustline";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { DestinationReadError } from "@/lib/close-api/merge-preflight";
import {
  assessLiveTransferDestination,
  type TransferDestinationProblem,
} from "@/lib/close-api/transfer-destinations";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

/** Matches the cap transfer-destinations.ts uses: destinations come from the request body. */
const READ_CONCURRENCY = 10;

export interface TransferCheck {
  asset: string;
  destination: string;
  /** Whole stroops the transfer will move. */
  amount: bigint;
}

/**
 * Re-checks each transfer against its destination's trustline as the ledger holds it now, for
 * the amount about to move. The plan-time check ran against a snapshot and the amount has since
 * changed (a deposit, a claim); a transfer that no longer fits would revert the whole atomic
 * close at the last round. A failed read throws `DestinationReadError`, never "missing".
 */
export async function findTransferProblems(
  server: LedgerReader,
  checks: TransferCheck[]
): Promise<TransferDestinationProblem[]> {
  const problems: TransferDestinationProblem[] = [];
  // An issuer holds no line for its own asset; paying it is a burn the ledger accepts.
  const readable = checks.filter((c) => c.asset.split(":")[1] !== c.destination);
  for (let i = 0; i < readable.length; i += READ_CONCURRENCY) {
    const slice = readable.slice(i, i + READ_CONCURRENCY);
    const lines = await Promise.all(
      slice.map(async (c) => {
        const [code, issuer] = c.asset.split(":");
        try {
          return await readLiveTrustline(
            server,
            c.destination,
            new Asset(code!, issuer!),
            `The ${code} trustline of ${c.destination}`
          );
        } catch (e) {
          if (e instanceof LiveReadError) throw new DestinationReadError(c.destination);
          throw e;
        }
      })
    );
    slice.forEach((c, j) => {
      const problem = assessLiveTransferDestination(
        c.asset,
        c.destination,
        lines[j] ?? null,
        c.amount
      );
      if (problem) problems.push(problem);
    });
  }
  return problems;
}
