import "server-only";
import { Address, scValToNative, Transaction, xdr } from "@stellar/stellar-sdk";

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
// - the contract is pinned for its protocol below, or is an instance the session itself seeded for
//   that protocol, and the protocol is one the session seeded at all;
// - the function is in that protocol's allowlist, with exactly the arguments the protocol's exit
//   uses: every argument that names the account paid or acted for equals the demo, and every
//   minimum-out is greater than zero;
// - every authorization entry is satisfied by the transaction's own signature (source-account
//   credentials, never a separate address signature), and every invocation in its tree stays in
//   the protocol's family: its pinned contracts and the session's instances.

export class SorobanVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanVerificationError";
  }
}

export type SorobanProtocol = "soroswap";

/** A protocol the session seeded on testnet, with the contract instances it created for it. */
export interface SeededProtocol {
  protocol: SorobanProtocol;
  instances: readonly string[];
}

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
}

interface ProtocolPins {
  contracts: readonly string[];
  functions: Readonly<Record<string, FunctionRule>>;
}

/**
 * Testnet contracts restated, not imported, from apps/api/src/config/contract-registry.json (the
 * playground never imports apps/api). A row is added only with the protocol's seeding scenario.
 *
 * Soroswap: the router (registry entry `soroswap` / `router`, version v1). Its exit is the call
 * apps/api/src/lib/defi-exits/soroswap.ts builds:
 * `remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to, deadline)`.
 */
export const PINNED_SOROBAN_PROTOCOLS: Readonly<Record<SorobanProtocol, ProtocolPins>> = {
  soroswap: {
    contracts: ["CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"],
    functions: {
      remove_liquidity: { arity: 7, accountArgs: [5], minOutArgs: [3, 4] },
    },
  },
};

const PROTOCOLS = Object.keys(PINNED_SOROBAN_PROTOCOLS) as SorobanProtocol[];

/** The protocol a contract belongs to, by the pinned table first, then the session's instances. */
function protocolOf(contract: string, expected: SorobanExpectation): SorobanProtocol | null {
  const pinned = PROTOCOLS.find((p) => PINNED_SOROBAN_PROTOCOLS[p].contracts.includes(contract));
  if (pinned) return pinned;
  return expected.seeded.find((s) => s.instances.includes(contract))?.protocol ?? null;
}

const addressOf = (val: xdr.ScVal | undefined): string | null =>
  val?.type === "scvAddress" ? Address.fromScAddress(val.address).toString() : null;

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

  const protocol = protocolOf(contract, expected);
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
    const arg = args[i];
    if (arg?.type !== "scvI128" || !((scValToNative(arg) as bigint) > BigInt(0))) {
      throw new SorobanVerificationError("soroban_min_out_not_positive");
    }
  }

  const family = new Set([...pins.contracts, ...seeded.instances]);
  for (const entry of op.auth ?? []) {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      throw new SorobanVerificationError("soroban_auth_credentials_not_source");
    }
    assertAuthTree(entry.rootInvocation, family);
  }
}
