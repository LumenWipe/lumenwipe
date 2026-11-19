// Keeps the testnet web authentication contract that contract-account sign-in uses from archiving:
// extends its instance and its code back to about 30 days. Testnet only, and it creates nothing.
//
//   INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET=C... bun run web-auth:testnet-ttl
//
// Extending needs no authorization, so no secret is read: a Friendbot throwaway, printed by its
// public key only, pays. The contract must run the attested SEP-45 reference build as a Wasm
// executable; anything else (another hash, a CAP-85 external reference, a Stellar asset, nothing
// at all) is refused before anything is funded or sent.
import { StrKey } from "@stellar/stellar-sdk";
import { SEP45_REFERENCE_WASM_HASH } from "@/integrator/contract-auth";
import {
  assertTestnet,
  b64,
  codeKey,
  defaultDeps,
  entries,
  extendFootprint,
  instanceKey,
  instanceState,
  PhoenixTestnetError,
  type PhoenixTestnetDeps,
} from "./phoenix-testnet-pool";

/** The variable that names the contract, the same one the API reads. */
export const CONTRACT_ENV = "INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET";

export class WebAuthTtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthTtlError";
  }
}

/** Extends the instance of `contract` and the reference code, once both are confirmed live and the
 *  instance runs that code. Returns how many entries were extended. */
export async function extendWebAuthTtl(
  contract: string,
  deps: PhoenixTestnetDeps
): Promise<number> {
  await assertTestnet(deps);
  const keys = [instanceKey(contract), codeKey(SEP45_REFERENCE_WASM_HASH)];
  const live = await entries(deps.rpc, keys);
  const state = instanceState(live.get(b64(keys[0]!)), SEP45_REFERENCE_WASM_HASH);
  if (state !== "expected") throw new WebAuthTtlError(`web_auth_${state}`);
  if (!live.has(b64(keys[1]!))) throw new WebAuthTtlError("code_missing");
  return (await extendFootprint(deps, keys)).length;
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  deps: () => PhoenixTestnetDeps = defaultDeps
): Promise<number> {
  const contract = env[CONTRACT_ENV]?.trim();
  if (!contract || !StrKey.isValidContract(contract)) {
    process.stderr.write(
      `Refused: ${CONTRACT_ENV} must hold the testnet web authentication contract (C...).\n`
    );
    return 1;
  }
  const d = deps();
  try {
    const extended = await extendWebAuthTtl(contract, d);
    d.log(`extended ${extended} entries of ${contract}`);
    return 0;
  } catch (err) {
    const reason =
      err instanceof WebAuthTtlError || err instanceof PhoenixTestnetError
        ? err.message
        : String(err);
    process.stderr.write(`The testnet web authentication contract was not extended: ${reason}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
