import type { AccountState, ErrorCode } from "@lumenwipe/types";
import type { KillSwitches } from "@/config/kill-switches";
import {
  laterOwnFeesStroops,
  ownFeeShortfallStroops,
  tokenRoundsAhead,
} from "@/lib/stellar/claim-reserve";
import { stroopsToFixedXlm } from "@/lib/utils/amounts";
import { groupExitTargets, PROTOCOL_LABEL, shortContract } from "@/lib/defi-exits/plan-exits";
import { isTokenContract } from "@/lib/close-api/decisions";

export type ConversionProvider = "soroswap" | "xbull";

export interface KillSwitchBlocker {
  code: ErrorCode;
  message: string;
  /** What `/close/transactions` answers with when it refuses on this blocker. */
  status: 422 | 503;
}

export interface KillSwitchContext {
  viaMediator: boolean;
  dispositions: Readonly<Record<string, string>>;
  /** Per token answered convert, the provider whose quote the answer accepted. Unnamed is Soroswap,
   *  the provider the build re-quotes through for such an answer. */
  conversionProviders: Readonly<Record<string, ConversionProvider>>;
}

function forwardBlocker(switches: KillSwitches): KillSwitchBlocker | null {
  if (!switches.mediatorConfigured) {
    return {
      code: "mediator_not_configured",
      message:
        "Closing into an exchange is not available on this network. Choose a wallet you control " +
        "as the destination.",
      status: 503,
    };
  }
  if (!switches.mediatorForward) {
    return {
      code: "exchange_forward_paused",
      message:
        "Closing into an exchange is paused right now. Choose a wallet you control as the " +
        "destination, or try again later.",
      status: 503,
    };
  }
  return null;
}

function exitBlockers(state: AccountState, switches: KillSwitches): KillSwitchBlocker[] {
  if (switches.pausedExits.size === 0) return [];
  return groupExitTargets(state.defiPositions.positions)
    .filter((target) => switches.pausedExits.has(target.protocol))
    .map((target) => {
      const label = PROTOCOL_LABEL[target.protocol];
      const one = target.positions.length === 1;
      return {
        code: "defi_exit_paused",
        message:
          `Exits from ${label} are paused right now, so the ${label} position${one ? "" : "s"} ` +
          `in ${shortContract(target.contract)} cannot be closed, and the account cannot be ` +
          "merged while it stays open. Try again later.",
        status: 503,
      };
    });
}

function conversionBlockers(
  state: AccountState,
  switches: KillSwitches,
  ctx: KillSwitchContext
): KillSwitchBlocker[] {
  const on: Record<ConversionProvider, boolean> = {
    soroswap: switches.sorobanConversion,
    xbull: switches.xbullConversion,
  };
  return Object.entries(ctx.dispositions)
    .filter(
      ([asset, disposition]) =>
        disposition === "convert" &&
        isTokenContract(asset) &&
        !on[ctx.conversionProviders[asset] ?? "soroswap"]
    )
    .map(([contract]) => {
      const symbol = state.sorobanTokens?.tokens.find((t) => t.contract === contract)?.symbol;
      return {
        code: "soroban_token_conversion_unavailable",
        message:
          `Converting ${symbol ?? `the ${shortContract(contract)} token`} to XLM is paused ` +
          "right now. Send it to another account, leave it on record, or try again later.",
        status: 422,
      };
    });
}

function sponsorshipBlocker(
  state: AccountState,
  switches: KillSwitches,
  ctx: KillSwitchContext
): KillSwitchBlocker | null {
  if (switches.feeSponsorship) return null;
  const sorobanRounds =
    2 * state.defiPositions.positions.length + tokenRoundsAhead(state, ctx.dispositions);
  // With Soroban rounds ahead no sponsor could pay anyway, and the fee shortfall says so itself.
  if (sorobanRounds > 0) return null;
  const short = ownFeeShortfallStroops(
    state,
    laterOwnFeesStroops(state, sorobanRounds, ctx.viaMediator)
  );
  if (short <= 0n) return null;
  return {
    code: "fee_sponsorship_paused",
    message:
      `Fee sponsorship is paused right now. This account needs ${stroopsToFixedXlm(short)} XLM ` +
      "more above its reserve to pay its own network fees. Add that much XLM, or try again later.",
    status: 503,
  };
}

/**
 * What the switched-off paths stop for this close. The one source of these blockers for both the
 * plan and the build, so the two can never disagree about a paused path.
 */
export function killSwitchBlockers(
  state: AccountState,
  switches: KillSwitches,
  ctx: KillSwitchContext
): KillSwitchBlocker[] {
  const forward = ctx.viaMediator ? forwardBlocker(switches) : null;
  const sponsorship = sponsorshipBlocker(state, switches, ctx);
  return [
    ...(forward ? [forward] : []),
    ...exitBlockers(state, switches),
    ...conversionBlockers(state, switches, ctx),
    ...(sponsorship ? [sponsorship] : []),
  ];
}
