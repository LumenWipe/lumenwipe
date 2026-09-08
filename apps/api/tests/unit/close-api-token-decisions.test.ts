/**
 * Soroban token decisions: every held token is asked about, leaving is explicit and only for a
 * token, and the contracts an answer names come back for the close rounds to re-read.
 */
import { expect, test } from "bun:test";
import { Address, Keypair } from "@stellar/stellar-sdk";
import type { AccountState, SorobanTokenBalance } from "@lumenwipe/types";
import {
  LEAVE_CHOICE,
  TRANSFER_CHOICE,
  deriveTokenDecisionPoints,
  resolveDispositions,
  tokenAssetsById,
  tokenContractsFromAnswers,
  tokenDecisionId,
} from "@/lib/close-api/decisions";

const TOKEN_A = Address.contract(Buffer.alloc(32, 1)).toString();
const TOKEN_B = Address.contract(Buffer.alloc(32, 2)).toString();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

function held(
  contract: string,
  balance: string,
  over: Partial<SorobanTokenBalance> = {}
): SorobanTokenBalance {
  return { contract, balance, symbol: "TKN", decimals: 7, sources: ["explorer"], ...over };
}

function withTokens(tokens: SorobanTokenBalance[]): Pick<AccountState, "sorobanTokens"> {
  return {
    sorobanTokens: { tokens, unreadable: [], coverage: [], eventsScanned: null, warnings: [] },
  };
}

test("every token with a balance gets a required decision: transfer and leave always, convert only with a route and readable metadata", () => {
  const points = deriveTokenDecisionPoints(
    withTokens([held(TOKEN_A, "100"), held(TOKEN_B, "7", { symbol: null, decimals: null })]),
    { [TOKEN_A]: true, [TOKEN_B]: true }
  );
  expect(points.map((p) => p.id)).toEqual([tokenDecisionId(TOKEN_A), tokenDecisionId(TOKEN_B)]);
  const [a, b] = points;
  expect(a!.required).toBe(true);
  expect(a!.options.map((o) => o.id)).toEqual(["convert_to_xlm", TRANSFER_CHOICE, LEAVE_CHOICE]);
  expect(a!.default).toBe("convert_to_xlm");
  expect(a!.subject).toMatchObject({ kind: "soroban_token", contract: TOKEN_A, convertible: true });
  // No symbol or decimals: a swap amount nobody can read is not a decision anyone can make.
  expect(b!.options.map((o) => o.id)).toEqual([TRANSFER_CHOICE, LEAVE_CHOICE]);
  expect(b!.default).toBe(TRANSFER_CHOICE);
  expect(b!.subject).toMatchObject({ convertible: false, symbol: null, decimals: null });
});

test("leaving is never the default, and a token with no balance asks nothing", () => {
  const points = deriveTokenDecisionPoints(
    withTokens([held(TOKEN_A, "0"), held(TOKEN_B, "1")]),
    {}
  );
  expect(points).toHaveLength(1);
  expect(points[0]!.id).toBe(tokenDecisionId(TOKEN_B));
  expect(points[0]!.default).not.toBe(LEAVE_CHOICE);
  expect(deriveTokenDecisionPoints({ sorobanTokens: undefined }, {})).toEqual([]);
});

test("acknowledge_residue resolves to leave for a token only; return_to_issuer never applies to a token", () => {
  const byId = [
    { id: tokenDecisionId(TOKEN_A), asset: TOKEN_A },
    { id: tokenDecisionId(TOKEN_B), asset: TOKEN_B },
    { id: `asset:${USDC.replace(":", "-")}`, asset: USDC },
  ];
  const resolved = resolveDispositions(
    [
      { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      { id: tokenDecisionId(TOKEN_B), choice: "return_to_issuer" },
      { id: `asset:${USDC.replace(":", "-")}`, choice: LEAVE_CHOICE },
    ],
    byId
  );
  expect(resolved).toEqual({ [TOKEN_A]: "leave" });
});

test("the token contracts an answer set names come back deduplicated and well-formed, nothing else", () => {
  expect(
    tokenContractsFromAnswers([
      { id: tokenDecisionId(TOKEN_A), choice: TRANSFER_CHOICE },
      { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      { id: tokenDecisionId(TOKEN_B), choice: "convert_to_xlm" },
      { id: "token:not-a-contract", choice: LEAVE_CHOICE },
      { id: `asset:${USDC.replace(":", "-")}`, choice: "convert_to_xlm" },
      { id: 42 as unknown as string, choice: "x" },
    ])
  ).toEqual([TOKEN_A, TOKEN_B]);
});

test("tokenAssetsById lists only balances the decision machinery can act on", () => {
  expect(
    tokenAssetsById(withTokens([held(TOKEN_A, "3"), held(TOKEN_B, "0"), held(TOKEN_B, "x")]))
  ).toEqual([{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }]);
});
