import "server-only";
import { Address, scValToNative, Transaction, xdr } from "@stellar/stellar-sdk";
import { SOROSWAP } from "./scenarios";

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
//   minimum-out and every amount moved is greater than zero, and the tokens named are exactly the
//   pinned pool's;
// - every authorization entry is satisfied by the transaction's own signature (source-account
//   credentials, never a separate address signature), and every invocation in its tree stays in
//   the protocol's family: the contracts its row pins, the call targets and the pool or pair.
//
// Every contract is a pinned public testnet instance (lib/scenarios/pinned.ts): a session never
// creates one, so there is nothing per session to record beyond which protocols it seeded.

export class SorobanVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanVerificationError";
  }
}

export type SorobanProtocol = "soroswap";

/** A protocol the session's selection seeds on testnet, and the variant of its position. */
export type SeededProtocol = { protocol: "soroswap"; variant: "lp" };

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
  /** Positions of minimum-out amounts: each must be an i128 greater than zero. */
  minOutArgs: readonly number[];
  /** Positions of the amount the call moves: each must be an i128 greater than zero. */
  positiveArgs: readonly number[];
  /** Positions that must name, between them, exactly these token contracts, each once. */
  tokenArgs: { at: readonly number[]; tokens: readonly string[] } | null;
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
 */
export const PINNED_SOROBAN_PROTOCOLS: Readonly<Record<SorobanProtocol, ProtocolPins>> = {
  soroswap: {
    entry: [SOROSWAP.router],
    family: [SOROSWAP.pair],
    functions: {
      remove_liquidity: {
        arity: 7,
        accountArgs: [5],
        minOutArgs: [3, 4],
        positiveArgs: [2],
        tokenArgs: { at: [0, 1], tokens: SOROSWAP.tokens },
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

const isPositiveI128 = (val: xdr.ScVal | undefined): boolean =>
  val?.type === "scvI128" && (scValToNative(val) as bigint) > BigInt(0);

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
  if (!expected.seeded.some((s) => s.protocol === protocol)) {
    throw new SorobanVerificationError("soroban_protocol_not_seeded");
  }
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
    if (!isPositiveI128(args[i]))
      throw new SorobanVerificationError("soroban_min_out_not_positive");
  }
  for (const i of rule.positiveArgs) {
    if (!isPositiveI128(args[i])) throw new SorobanVerificationError("soroban_amount_not_positive");
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

  const family = new Set([...pins.entry, ...pins.family]);
  for (const entry of op.auth ?? []) {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      throw new SorobanVerificationError("soroban_auth_credentials_not_source");
    }
    assertAuthTree(entry.rootInvocation, family);
  }
}
