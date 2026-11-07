import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { ClassicConversionFloor, TokenConversionFloor } from "@/store/demolish";
import { formatStroops, formatTokenBalance } from "@/lib/api/plan-adapters";
import { xlmToStroops } from "@/lib/utils/amounts";
import { isTokenContract } from "@/lib/api/close-decisions";

/** The store values an outcome is read from: the user's own answers, never the plan's text. */
export interface AssetOutcomeInput {
  account: Pick<AccountState, "trustlines" | "claimableBalances" | "sorobanTokens">;
  dispositions: Readonly<Record<string, AssetDisposition>>;
  transferDestinations: Readonly<Record<string, string>>;
  tokenConversionFloors: Readonly<Record<string, TokenConversionFloor>>;
  classicConversionFloors: Readonly<Record<string, ClassicConversionFloor>>;
  claimSelections: Readonly<Record<string, ClaimableBalanceSelection>>;
}

export type OutcomeAction = AssetDisposition | "claim" | "forfeit" | "undecided";

export interface AssetOutcome {
  /** The asset (`CODE:ISSUER`), token contract or claimable balance id. */
  key: string;
  kind: "classic" | "token" | "claim";
  code: string;
  /** The classic issuer, shown so two assets with one code cannot be confused. */
  issuer: string | null;
  contract: string | null;
  /** The code is the symbol a token contract reports for itself, which anyone can choose. */
  symbolFromContract: boolean;
  /** The amount, formatted; null when it only arrives during the close. */
  amount: string | null;
  action: OutcomeAction;
  /** Where a transfer sends the balance, in full. */
  destination: string | null;
  /** For a swap: the least XLM the plan quoted, in stroops; null when it quoted none. */
  minimumStroops: string | null;
  /** For a claimed XLM balance: what it adds to what arrives, in stroops. */
  claimedStroops: string | null;
  /** The user gives the value up. */
  givenUp: boolean;
}

const LUMENS = /^\d+(?:\.\d{1,7})?$/;

/** Amounts come from an API response: anything but a string of XLM is shown as it came and
 *  never reaches xlmToStroops. */
function isLumens(value: unknown): value is string {
  return typeof value === "string" && LUMENS.test(value);
}

function classicAmount(balance: unknown): string | null {
  if (!isLumens(balance)) return String(balance);
  const stroops = xlmToStroops(balance);
  return stroops === "0" ? null : formatStroops(stroops);
}

function tokenAmount(balance: unknown, decimals: number | null): string | null {
  if (typeof balance !== "string") return String(balance);
  return balance === "0" ? null : formatTokenBalance(balance, decimals);
}

function assetOutcome(
  input: AssetOutcomeInput,
  base: Pick<
    AssetOutcome,
    "key" | "kind" | "code" | "issuer" | "contract" | "amount" | "symbolFromContract"
  >
): AssetOutcome {
  const action: OutcomeAction = input.dispositions[base.key] ?? "undecided";
  const minimum =
    action !== "convert"
      ? null
      : base.kind === "token"
        ? (input.tokenConversionFloors[base.key]?.minAmountOut ?? null)
        : (input.classicConversionFloors[base.key]?.minAmountOut ?? null);
  return {
    ...base,
    action,
    destination: action === "transfer" ? (input.transferDestinations[base.key] ?? null) : null,
    minimumStroops: minimum,
    claimedStroops: null,
    givenUp: action === "issuer" || action === "leave",
  };
}

/**
 * One row per asset, token and claimable balance the close decides about, in that order.
 *
 * A swap's minimum is read from the same floors the plan page saved for the convert answers, the
 * ones the expected-receive figure counts, so the rows add up to that figure's swap line.
 */
export function assetOutcomes(input: AssetOutcomeInput): AssetOutcome[] {
  const rows: AssetOutcome[] = [];
  const seen = new Set<string>();

  for (const tl of input.account.trustlines) {
    if (tl.asset === "native") continue;
    const amount = classicAmount(tl.balance);
    if (amount === null && input.dispositions[tl.asset] === undefined) continue;
    seen.add(tl.asset);
    rows.push(
      assetOutcome(input, {
        key: tl.asset,
        kind: "classic",
        code: tl.code,
        issuer: tl.issuer,
        contract: null,
        symbolFromContract: false,
        amount,
      })
    );
  }

  // An asset that only arrives through a claim has no trustline yet, but its answer still runs.
  for (const b of input.account.claimableBalances) {
    if (b.asset === "native" || seen.has(b.asset) || input.dispositions[b.asset] === undefined) {
      continue;
    }
    seen.add(b.asset);
    const [code, issuer] = b.asset.split(":");
    rows.push(
      assetOutcome(input, {
        key: b.asset,
        kind: "classic",
        code,
        issuer: issuer ?? null,
        contract: null,
        symbolFromContract: false,
        amount: null,
      })
    );
  }

  for (const t of input.account.sorobanTokens?.tokens ?? []) {
    if (t.balance === "0" && input.dispositions[t.contract] === undefined) continue;
    rows.push(
      assetOutcome(input, {
        key: t.contract,
        kind: "token",
        code: t.symbol ?? "token",
        issuer: null,
        contract: t.contract,
        symbolFromContract: t.symbol !== null,
        amount: tokenAmount(t.balance, t.decimals),
      })
    );
    seen.add(t.contract);
  }

  // Every answer runs at build time and in verify(), so each one has a row, even for an asset the
  // account read does not list (a token only an exit pays in, for one).
  for (const key of Object.keys(input.dispositions)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const token = isTokenContract(key);
    // Nothing the store holds names a token by more than its contract, shown in full below.
    const [code, issuer] = token ? ["token", undefined] : key.split(":");
    rows.push(
      assetOutcome(input, {
        key,
        kind: token ? "token" : "classic",
        code,
        issuer: issuer ?? null,
        contract: token ? key : null,
        symbolFromContract: false,
        amount: null,
      })
    );
  }

  for (const b of input.account.claimableBalances) {
    const selection = input.claimSelections[b.id];
    const native = b.asset === "native";
    const [code, issuer] = native ? ["XLM", undefined] : b.asset.split(":");
    const forfeit = selection === "forfeit";
    rows.push({
      key: b.id,
      kind: "claim",
      code,
      issuer: issuer ?? null,
      contract: null,
      symbolFromContract: false,
      amount: classicAmount(b.amount),
      action: selection === undefined ? "undecided" : forfeit ? "forfeit" : "claim",
      destination: null,
      minimumStroops: null,
      claimedStroops:
        native && selection !== undefined && !forfeit && isLumens(b.amount)
          ? xlmToStroops(b.amount)
          : null,
      givenUp: forfeit,
    });
  }

  return rows;
}
