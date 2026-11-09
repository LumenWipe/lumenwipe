import "server-only";
import { Keypair, Operation, xdr } from "@stellar/stellar-sdk";
import { submitSoroban, type SorobanSubmitDeps } from "./soroban-submit";

// The seeding scaffold for protocol exit scenarios: one contract call, signed by the key that
// acts, through lib/soroban-submit.ts. The executors build their positions with it; it never
// imports the verifier, which checks the close against the session record, not against this.
//
// Duplicated on purpose rather than shared with the API's test fixtures: those import API
// internals, and the playground may not import apps/api (eslint.config.mjs).

/** One contract function call, with its arguments already encoded. */
export interface ContractCall {
  contract: string;
  function: string;
  args: xdr.ScVal[];
}

export const contractCallOp = (call: ContractCall): xdr.Operation =>
  Operation.invokeContractFunction({
    contract: call.contract,
    function: call.function,
    args: call.args,
  });

/** Make one contract call as `source` on testnet and wait for it to confirm. */
export function seedContractCall(
  source: Keypair,
  call: ContractCall,
  deps: Partial<SorobanSubmitDeps> = {}
): Promise<{ txHash: string }> {
  return submitSoroban(source, contractCallOp(call), deps);
}
