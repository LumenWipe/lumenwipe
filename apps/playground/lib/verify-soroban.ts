import "server-only";
import { Address, scValToNative, Transaction, xdr } from "@stellar/stellar-sdk";
import { AQUARIUS, BLEND, BLEND_REQUEST, SOROSWAP, type BlendVariant } from "./scenarios";

// The structural check for a Soroban contract call in a playground close.
//
// `@lumenwipe/verify` already holds a DeFi exit to the positions the account read named, but the
// playground has no account read it can vouch for: what it trusts is its own configuration and
// the session record. So before the shared verifier runs (lib/verify.ts), a transaction that holds
// an `invokeHostFunction` must also pass this check, built only from those two sources and never
// from the API's response:
//
// - the call is the transaction's only operation, it calls a contract function (never create or
//   upload a contract), and it acts as the demo;
// - the contract is one the protocol's pinned row lets a call be made to, and the protocol is one
//   the session's selection seeds;
// - the function is in that protocol's allowlist, with exactly the arguments the protocol's exit
//   uses: every argument that names the account paid or acted for equals the demo, every
//   minimum-out and every amount moved is greater than zero (a floor given as a list holds exactly
//   one per pool token), the tokens named are exactly the pinned pool's, and a lending pool's
//   requests are a non-empty list naming only the pinned reserve, each moving a positive amount,
//   of only the request types the seeded variant's exit needs;
// - every authorization entry is satisfied by the transaction's own signature (source-account
//   credentials, never a separate address signature), and every invocation in its tree stays in
//   the protocol's family: the contracts its row pins, the call targets and the pool, pair or
//   share token.
//
// Every contract is a pinned public testnet instance (lib/scenarios/pinned.ts): a session never
// creates one, so there is nothing per session to record beyond which protocols it seeded.

export class SorobanVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanVerificationError";
  }
}

export type SorobanProtocol = "soroswap" | "aquarius" | "blend";

/** A protocol the session's selection seeds on testnet, and the variant of its position. */
export type SeededProtocol =
  | { protocol: "soroswap"; variant: "lp" }
  | { protocol: "aquarius"; variant: "lp" }
  | { protocol: "blend"; variant: BlendVariant };

/** What a session's Soroban calls may do: everything here comes from the session record. */
export interface SorobanExpectation {
  demoPublic: string;
  seeded: readonly SeededProtocol[];
}

interface FunctionRule {
  /** The exact argument count. */
  arity: number;
  /** Positions of arguments that name the account paid or acted for: each must be the demo. */
  accountArgs: readonly number[];
  /** The integer type every amount below must have: the protocol's own, never another. */
  amountType: "scvI128" | "scvU128";
  /** Positions of minimum-out amounts: each must be greater than zero. */
  minOutArgs: readonly number[];
  /** A minimum-out given as one list: exactly `length` amounts, each greater than zero. */
  minOutVec: { at: number; length: number } | null;
  /** Positions of the amount the call moves: each must be greater than zero. */
  positiveArgs: readonly number[];
  /** Positions that must name, between them, exactly these token contracts, each once. */
  tokenArgs: { at: readonly number[]; tokens: readonly string[] } | null;
  /**
   * A list of lending requests `{ address, amount, request_type }`: not empty, every address the
   * pinned `reserve`, every amount greater than zero, and every type one the seeded variant's exit
   * uses (`types`, by variant; a variant not listed allows none).
   */
  requests: {
    at: number;
    reserve: string;
    types: Readonly<Partial<Record<SeededProtocol["variant"], readonly number[]>>>;
  } | null;
}

interface ProtocolPins {
  /** The contracts a call may be made to. */
  entry: readonly string[];
  /** The other contracts its authorization tree may reach, such as the pool or pair. */
  family: readonly string[];
  functions: Readonly<Record<string, FunctionRule>>;
}

/**
 * One row per protocol, from lib/scenarios/pinned.ts, added only with the protocol's seeding
 * scenario.
 *
 * Soroswap: the router (registry entry `soroswap` / `router`, version v1) and the Circle-USDC/XLM
 * pair the scenario deposits in. Its exit is the call apps/api/src/lib/defi-exits/soroswap.ts
 * builds: `remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to,
 * deadline)`, which authorizes moving the LP share from the demo into the pair, and nothing else.
 *
 * Aquarius: the Circle-USDC/XLM constant-product pool the scenario deposits in (its code is the
 * registry's `aquarius` / `pool` constant-product entry) and its share token. Its exit is the call
 * apps/api/src/lib/defi-exits/aquarius.ts builds: `withdraw(user, share_amount, min_amounts)`,
 * made to the pool itself, which authorizes burning the demo's shares on the share token, and
 * nothing else. The pool's AQUA emission rate is zero on testnet, so no `claim` comes before it.
 *
 * Blend: the pinned pool, the only contract a call may be made to, and XLM's contract, the only
 * other one its authorization tree may reach (the repay moves the demo's XLM into the pool). Its
 * exit is the call apps/api/src/lib/defi-exits/blend.ts builds per step, `submit(from, spender,
 * to, requests)`, with the demo on all three sides: a collateral withdrawal (type 3), and before it
 * a repay (type 5) only when the selection borrowed. XLM's reserve has no emissions on either
 * token id, so no `claim` comes before it.
 */
export const PINNED_SOROBAN_PROTOCOLS: Readonly<Record<SorobanProtocol, ProtocolPins>> = {
  soroswap: {
    entry: [SOROSWAP.router],
    family: [SOROSWAP.pair],
    functions: {
      remove_liquidity: {
        arity: 7,
        accountArgs: [5],
        amountType: "scvI128",
        minOutArgs: [3, 4],
        minOutVec: null,
        positiveArgs: [2],
        tokenArgs: { at: [0, 1], tokens: SOROSWAP.tokens },
        requests: null,
      },
    },
  },
  aquarius: {
    entry: [AQUARIUS.pool],
    family: [AQUARIUS.shareToken],
    functions: {
      withdraw: {
        arity: 3,
        accountArgs: [0],
        amountType: "scvU128",
        minOutArgs: [],
        minOutVec: { at: 2, length: AQUARIUS.tokens.length },
        positiveArgs: [1],
        tokenArgs: null,
        requests: null,
      },
    },
  },
  blend: {
    entry: [BLEND.pool],
    family: [BLEND.reserve],
    functions: {
      submit: {
        arity: 4,
        accountArgs: [0, 1, 2],
        amountType: "scvI128",
        minOutArgs: [],
        minOutVec: null,
        positiveArgs: [],
        tokenArgs: null,
        requests: {
          at: 3,
          reserve: BLEND.reserve,
          types: {
            supply: [BLEND_REQUEST.withdrawCollateral],
            supply_and_borrow: [BLEND_REQUEST.withdrawCollateral, BLEND_REQUEST.repay],
          },
        },
      },
    },
  },
};

const PROTOCOLS = Object.keys(PINNED_SOROBAN_PROTOCOLS) as SorobanProtocol[];

/** The protocol a call to `contract` belongs to: the one whose row lets a call be made to it. */
function protocolOf(contract: string): SorobanProtocol | null {
  return PROTOCOLS.find((p) => PINNED_SOROBAN_PROTOCOLS[p].entry.includes(contract)) ?? null;
}

const addressOf = (val: xdr.ScVal | undefined): string | null =>
  val?.type === "scvAddress" ? Address.fromScAddress(val.address).toString() : null;

const isPositive = (val: xdr.ScVal | undefined, type: FunctionRule["amountType"]): boolean =>
  val?.type === type && (scValToNative(val) as bigint) > BigInt(0);

const REQUEST_KEYS = ["address", "amount", "request_type"];

/** Throws unless `val` is a non-empty list of requests the rule and the seeded variant allow. */
function assertRequests(
  val: xdr.ScVal | undefined,
  rule: NonNullable<FunctionRule["requests"]>,
  variant: SeededProtocol["variant"],
  amountType: FunctionRule["amountType"]
): void {
  const list = val?.type === "scvVec" ? (val.vec ?? []) : [];
  if (list.length === 0) throw new SorobanVerificationError("soroban_requests_invalid");
  const allowed = rule.types[variant] ?? [];
  for (const request of list) {
    const entries = request.type === "scvMap" ? (request.map ?? []) : [];
    const keys = entries.map((e) => (e.key.type === "scvSymbol" ? e.key.sym.toString() : null));
    if (keys.length !== REQUEST_KEYS.length || !keys.every((k, i) => k === REQUEST_KEYS[i])) {
      throw new SorobanVerificationError("soroban_requests_invalid");
    }
    const [address, amount, type] = entries.map((e) => e.val);
    if (addressOf(address) !== rule.reserve) {
      throw new SorobanVerificationError("soroban_request_reserve_not_pinned");
    }
    if (!isPositive(amount, amountType)) {
      throw new SorobanVerificationError("soroban_amount_not_positive");
    }
    if (type?.type !== "scvU32" || !allowed.includes(type.u32)) {
      throw new SorobanVerificationError("soroban_request_type_not_allowed");
    }
  }
}

function assertAuthTree(
  invocation: xdr.SorobanAuthorizedInvocation,
  family: ReadonlySet<string>
): void {
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new SorobanVerificationError("soroban_auth_not_contract_call");
  }
  const contract = Address.fromScAddress(fn.contractFn.contractAddress).toString();
  if (!family.has(contract)) throw new SorobanVerificationError("soroban_auth_outside_family");
  for (const sub of invocation.subInvocations) assertAuthTree(sub, family);
}

/** Throws a SorobanVerificationError unless the transaction is one allowed Soroban exit call. */
export function assertSorobanTransaction(tx: Transaction, expected: SorobanExpectation): void {
  if (tx.operations.length !== 1) throw new SorobanVerificationError("soroban_call_not_alone");
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") {
    throw new SorobanVerificationError("soroban_call_not_alone");
  }
  if ((op.source ?? tx.source) !== expected.demoPublic) {
    throw new SorobanVerificationError("soroban_source_mismatch");
  }
  if (op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new SorobanVerificationError("soroban_host_function_not_allowed");
  }
  const call = op.func.invokeContract;
  const contract = Address.fromScAddress(call.contractAddress).toString();

  const protocol = protocolOf(contract);
  if (!protocol) throw new SorobanVerificationError("soroban_contract_not_pinned");
  const seeded = expected.seeded.find((s) => s.protocol === protocol);
  if (!seeded) throw new SorobanVerificationError("soroban_protocol_not_seeded");
  const pins = PINNED_SOROBAN_PROTOCOLS[protocol];

  const name = call.functionName.toString();
  const rule = Object.prototype.hasOwnProperty.call(pins.functions, name)
    ? pins.functions[name]
    : undefined;
  if (!rule) throw new SorobanVerificationError("soroban_function_not_allowed");
  const args = call.args;
  if (args.length !== rule.arity) throw new SorobanVerificationError("soroban_arguments_invalid");
  for (const i of rule.accountArgs) {
    if (addressOf(args[i]) !== expected.demoPublic) {
      throw new SorobanVerificationError("soroban_account_argument_mismatch");
    }
  }
  for (const i of rule.minOutArgs) {
    if (!isPositive(args[i], rule.amountType)) {
      throw new SorobanVerificationError("soroban_min_out_not_positive");
    }
  }
  if (rule.minOutVec) {
    const floors = args[rule.minOutVec.at];
    const list = floors?.type === "scvVec" ? (floors.vec ?? []) : null;
    if (list === null || list.length !== rule.minOutVec.length) {
      throw new SorobanVerificationError("soroban_min_out_vec_invalid");
    }
    if (!list.every((floor) => isPositive(floor, rule.amountType))) {
      throw new SorobanVerificationError("soroban_min_out_not_positive");
    }
  }
  for (const i of rule.positiveArgs) {
    if (!isPositive(args[i], rule.amountType)) {
      throw new SorobanVerificationError("soroban_amount_not_positive");
    }
  }
  if (rule.tokenArgs) {
    const named = rule.tokenArgs.at.map((i) => addressOf(args[i]));
    const { tokens } = rule.tokenArgs;
    if (
      new Set(named).size !== named.length ||
      named.length !== tokens.length ||
      !named.every((t) => t !== null && tokens.includes(t))
    ) {
      throw new SorobanVerificationError("soroban_token_not_pinned");
    }
  }

  if (rule.requests) {
    assertRequests(args[rule.requests.at], rule.requests, seeded.variant, rule.amountType);
  }

  const family = new Set([...pins.entry, ...pins.family]);
  for (const entry of op.auth ?? []) {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      throw new SorobanVerificationError("soroban_auth_credentials_not_source");
    }
    assertAuthTree(entry.rootInvocation, family);
  }
}
