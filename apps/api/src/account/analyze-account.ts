import { HttpException, type Logger } from "@nestjs/common";
import type { AccountState } from "@lumenwipe/types";
import { fail } from "@/common/fail";
import type { Network } from "@/config/networks";
import { mapDomainError, UPSTREAM_ERRORS } from "@/lib/close-api/domain-errors";
import { getAccountState } from "@/lib/stellar/account-state";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import {
  AccountNotFoundError,
  AccountStateChangedError,
  UnusableProviderResponseError,
} from "@/lib/utils/errors";

/**
 * The account analysis behind `GET v1/:network/account/:address`, with the error each failure
 * answers. The user-path health probe runs this same function, so the two cannot drift apart.
 */
export async function analyzeAccount(
  address: string,
  network: Network,
  manualTokenCandidates: string[],
  logger: Logger
): Promise<AccountState> {
  try {
    // The analysis is where discovery happens, so the event scan runs here. An account holding
    // a Soroban-native token outside every curated list and every detected position would
    // otherwise come back as if it held nothing, and the close would then leave that balance
    // behind in silence. The scan is the only source that can find such a token, so paying for
    // it here is the difference between a correct close and a quiet loss.
    //
    // Its cost is bounded by the two-pass shape in soroban-tokens.ts: a ~0.6s shallow window
    // on every analysis, and the deeper sweep only for an account no other source could say
    // anything about. The close round still does not scan (read-account.ts) - by then the
    // tokens are known and it is re-confirming balances, not looking for more.
    return await getAccountState(address, network, {
      manualTokenCandidates,
      scanTokenEvents: true,
    });
  } catch (err) {
    if (err instanceof HttpException) throw err;
    if (err instanceof AccountNotFoundError) {
      fail("account_not_found", err.message, 404);
    }
    // A collection too large to enumerate is a property of the account, not a fault of ours,
    // and its message explains what the caller is up against. Collapsing it into a generic
    // 500 would leave someone staring at "Failed to fetch account data" with no idea why
    // their account cannot be read - the opposite of the "blocker with an explanation"
    // invariant.
    if (err instanceof TruncatedCollectionError) {
      fail("account_too_large", err.message, 422);
    }
    if (err instanceof AccountStateChangedError) {
      fail(
        "state_changed",
        "This account changed while it was being read. Nothing was submitted. Please try again.",
        409
      );
    }
    // Same reasoning, pointed at the operator rather than the account holder: the configured
    // provider answered with a body no plan can be built from, and the message names the
    // fields it omitted. 502 because the fault is upstream of us, not in the request - and
    // whoever wired that provider in can act on it, which "Failed to fetch account data"
    // gives them no way to do.
    if (err instanceof UnusableProviderResponseError) {
      fail("provider_response_unusable", err.message, 502);
    }
    const upstream = mapDomainError(UPSTREAM_ERRORS, err);
    if (upstream) fail(upstream.code, upstream.message, upstream.status);
    logger.error("account fetch failed", err instanceof Error ? err.stack : String(err));
    fail("account_read_failed", "Failed to fetch account data", 500);
  }
}
