import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  hash,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  scValToNative,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { loadHorizonAccount, SOROBAN_RPC_TESTNET_URL } from "./horizon-submit";
import { PLAYGROUND_TOKEN } from "./scenarios";

// The playground token on testnet (lib/scenarios/pinned.ts `PLAYGROUND_TOKEN`): where it lives,
// whether it is there, and the operator's one-off deployment of it (scripts/deploy-token.ts).
//
// Not server-only, so the operator script runs it with plain `bun`; it never reads a secret
// itself, and nothing a visitor reaches imports the deployment.

/** Where the token admin's secret key lives, on the playground's deployment and the nightly. */
export const TOKEN_ADMIN_SECRET_ENV = "PLAYGROUND_TOKEN_ADMIN_SECRET_TESTNET";

/** About 30 days of ledgers at five seconds each: what each deployment run extends the token's
 *  instance and code to. Every mint extends the instance again (the token code does it itself). */
export const TOKEN_TTL_LEDGERS = 518_400;

/** The most one deployment transaction may pay, in stroops: the TTL extension's rent is the
 *  largest, about 3.3 XLM for `TOKEN_TTL_LEDGERS` on 2026-11-18. */
export const DEPLOY_FEE_CAP_STROOPS = BigInt(100_000_000);

/** A token the operator deploys: the playground's, `PLAYGROUND_TOKEN`, on testnet. */
export interface TokenConfig {
  contract: string;
  admin: string;
  salt: string;
  wasmHash: string;
  name: string;
  symbol: string;
  decimals: number;
}

export class TokenDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenDeployError";
  }
}

/**
 * The contract a `createContract` from `deployer` with `saltHex` makes on the network
 * `passphrase` names: the hash of the network, the deployer and the salt, nothing else.
 */
export function contractIdFor(deployer: string, saltHex: string, passphrase: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt: Buffer.from(saltHex, "hex"),
        })
      ),
    })
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** The token admin's key from `secret`, or null when it is missing, unreadable or any other key. */
export function tokenAdminKeypair(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    return null;
  }
  return keypair.publicKey() === PLAYGROUND_TOKEN.admin ? keypair : null;
}

const instanceKey = (token: TokenConfig): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(token.contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    })
  );

const codeKey = (token: TokenConfig): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(token.wasmHash, "hex") })
  );

const archivalKey = (): xdr.LedgerKey =>
  xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
    })
  );

/** What the ledger holds for the token, from one read. */
export interface TokenLedger {
  /** missing: no instance at the pinned address. pinned_code: it runs the pinned code. other_code:
   *  something else lives there. */
  instance: "missing" | "pinned_code" | "other_code";
  /** The pinned token code is on the ledger. */
  codeLive: boolean;
  /** The network's longest entry TTL, in ledgers. */
  maxEntryTtl: number;
}

type LedgerReader = Pick<rpc.Server, "getLedgerEntries">;

/** Reads the token's instance, its code and the network's TTL bound in one call. */
export async function readTokenLedger(
  server: LedgerReader,
  token: TokenConfig = PLAYGROUND_TOKEN
): Promise<TokenLedger> {
  const keys = { instance: instanceKey(token), code: codeKey(token), archival: archivalKey() };
  const res = await server.getLedgerEntries(keys.instance, keys.code, keys.archival);
  const entryFor = (key: xdr.LedgerKey) =>
    res.entries.find((e) => e.key.toXDR("base64") === key.toXDR("base64"))?.val;
  const archival = entryFor(keys.archival);
  if (
    archival?.type !== "configSetting" ||
    archival.configSetting.type !== "configSettingStateArchival"
  ) {
    throw new TokenDeployError("ledger_unreadable");
  }
  const data = entryFor(keys.instance);
  let instance: TokenLedger["instance"] = "missing";
  if (data !== undefined) {
    const val = data.type === "contractData" ? data.contractData.val : null;
    const executable = val?.type === "scvContractInstance" ? val.instance.executable : null;
    const wasm =
      executable?.type === "contractExecutableWasm" ? executable.wasmHash.toXDR("hex") : null;
    instance = wasm === token.wasmHash ? "pinned_code" : "other_code";
  }
  return {
    instance,
    codeLive: entryFor(keys.code) !== undefined,
    maxEntryTtl: archival.configSetting.stateArchivalSettings.maxEntryTtl,
  };
}

/** Whether the pinned token is on testnet running the pinned code, which a session can mint. */
export async function playgroundTokenDeployed(
  server: LedgerReader,
  token: TokenConfig = PLAYGROUND_TOKEN
): Promise<boolean> {
  return (await readTokenLedger(server, token)).instance === "pinned_code";
}

export interface TokenDeployDeps {
  rpc: Pick<
    rpc.Server,
    "getLedgerEntries" | "simulateTransaction" | "sendTransaction" | "getTransaction"
  >;
  loadSequence: (address: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): TokenDeployDeps => ({
  rpc: new rpc.Server(SOROBAN_RPC_TESTNET_URL),
  loadSequence: async (address) => (await loadHorizonAccount(address)).sequenceNumber(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 60;

function buildTx(
  source: string,
  sequence: string,
  op: xdr.Operation,
  sorobanData?: xdr.SorobanTransactionData
): Transaction {
  const builder = new TransactionBuilder(new Account(source, sequence), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(op);
  if (sorobanData) builder.setSorobanData(sorobanData);
  return builder.setTimeout(60).build();
}

async function simulate(
  deps: TokenDeployDeps,
  tx: Transaction
): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const sim = await deps.rpc.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new TokenDeployError("simulation_failed");
  if (rpc.Api.isSimulationRestore(sim)) throw new TokenDeployError("simulation_needs_restore");
  return sim;
}

/**
 * Holds what the simulation assembled to what was built: the same operation, every
 * authorization satisfied by the admin's own signature, and the fee under the cap.
 */
export function assertAssembled(assembled: Transaction, built: Transaction): void {
  const [op] = assembled.operations;
  const [wanted] = built.operations;
  if (assembled.operations.length !== 1 || !op || !wanted || op.type !== wanted.type) {
    throw new TokenDeployError("assembled_operation_changed");
  }
  if (assembled.source !== built.source || (op.source ?? assembled.source) !== built.source) {
    throw new TokenDeployError("assembled_source_changed");
  }
  if (op.type === "invokeHostFunction" && wanted.type === "invokeHostFunction") {
    if (op.func.toXDR("base64") !== wanted.func.toXDR("base64")) {
      throw new TokenDeployError("assembled_operation_changed");
    }
    for (const entry of op.auth ?? []) {
      if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
        throw new TokenDeployError("auth_credentials_not_source");
      }
    }
  }
  if (BigInt(assembled.fee) > DEPLOY_FEE_CAP_STROOPS) throw new TokenDeployError("fee_above_cap");
}

/** Simulate, check, sign with the admin, send and wait for one operation's transaction. */
async function submit(
  admin: Keypair,
  deps: TokenDeployDeps,
  op: xdr.Operation,
  sorobanData?: xdr.SorobanTransactionData,
  check: (sim: rpc.Api.SimulateTransactionSuccessResponse) => void = () => {}
): Promise<void> {
  const built = buildTx(
    admin.publicKey(),
    await deps.loadSequence(admin.publicKey()),
    op,
    sorobanData
  );
  const sim = await simulate(deps, built);
  check(sim);
  const assembled = rpc.assembleTransaction(built, sim).build();
  assertAssembled(assembled, built);
  assembled.sign(admin);
  const sent = await deps.rpc.sendTransaction(assembled);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new TokenDeployError(`send_rejected: ${sent.status}`);
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const res = await deps.rpc.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new TokenDeployError(`transaction_failed: ${sent.hash}`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new TokenDeployError(`transaction_timeout: ${sent.hash}`);
}

const tokenCall = (token: TokenConfig, fn: string, ...args: xdr.ScVal[]): xdr.Operation =>
  new Contract(token.contract).call(fn, ...args);

/** The token's `decimals`, `name` and `symbol`, or null while it is not initialized. */
async function readMetadata(
  token: TokenConfig,
  deps: TokenDeployDeps
): Promise<{ decimals: unknown; name: unknown; symbol: unknown } | null> {
  const read = async (fn: string): Promise<unknown> => {
    const sim = await deps.rpc.simulateTransaction(buildTx(token.admin, "0", tokenCall(token, fn)));
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
    return scValToNative(sim.result.retval);
  };
  const [decimals, name, symbol] = [
    await read("decimals"),
    await read("name"),
    await read("symbol"),
  ];
  if (decimals === undefined) return null;
  return { decimals, name, symbol };
}

/**
 * Proves the pinned admin is the token's admin: a simulated `mint` sent by it records exactly one
 * authorization, satisfied by its own signature, for that mint. Run after `initialize`, which is a
 * transaction of its own that anyone could have sent first with another admin, whose own
 * signature the simulation would then record instead.
 */
export async function assertAdminMints(
  token: TokenConfig,
  deps: Pick<TokenDeployDeps, "rpc">
): Promise<void> {
  const one = nativeToScVal(1, { type: "i128" });
  const mint = tokenCall(token, "mint", new Address(token.admin).toScVal(), one);
  const sim = await deps.rpc.simulateTransaction(buildTx(token.admin, "0", mint));
  const auth = rpc.Api.isSimulationSuccess(sim) ? (sim.result?.auth ?? []) : [];
  const fn = auth[0]?.rootInvocation.function;
  const ok =
    auth.length === 1 &&
    auth[0]?.credentials.type === "sorobanCredentialsSourceAccount" &&
    fn?.type === "sorobanAuthorizedFunctionTypeContractFn" &&
    Address.fromScAddress(fn.contractFn.contractAddress).toString() === token.contract &&
    fn.contractFn.functionName.toString() === "mint";
  if (!ok) throw new TokenDeployError("admin_not_in_control");
}

/**
 * Creates the token with its admin and salt and initializes it, or, once it exists, checks it.
 * Each run ends with the admin's control proven and the instance and code extended. Refuses any
 * key but the token's admin, and a pinned address its admin and salt do not derive.
 */
export async function ensureToken(
  admin: Keypair,
  token: TokenConfig = PLAYGROUND_TOKEN,
  overrides: Partial<TokenDeployDeps> = {}
): Promise<string> {
  const deps = { ...defaultDeps(), ...overrides };
  const deployer = admin.publicKey();
  if (deployer !== token.admin) throw new TokenDeployError("key_not_pinned_admin");
  if (contractIdFor(deployer, token.salt, Networks.TESTNET) !== token.contract) {
    throw new TokenDeployError("contract_id_not_derived");
  }

  const ledger = await readTokenLedger(deps.rpc, token);
  if (!ledger.codeLive) throw new TokenDeployError("token_code_not_on_ledger");
  if (ledger.instance === "other_code") throw new TokenDeployError("contract_runs_other_code");
  if (ledger.instance === "missing") {
    const create = Operation.createCustomContract({
      address: Address.fromString(deployer),
      wasmHash: Buffer.from(token.wasmHash, "hex"),
      salt: Buffer.from(token.salt, "hex"),
    });
    await submit(admin, deps, create, undefined, (sim) => {
      const created = sim.result ? Address.fromScVal(sim.result.retval).toString() : null;
      if (created !== token.contract) throw new TokenDeployError("contract_id_mismatch");
    });
  }

  if ((await readMetadata(token, deps)) === null) {
    const initialize = tokenCall(
      token,
      "initialize",
      new Address(deployer).toScVal(),
      nativeToScVal(token.decimals, { type: "u32" }),
      nativeToScVal(token.name, { type: "string" }),
      nativeToScVal(token.symbol, { type: "string" })
    );
    await submit(admin, deps, initialize);
  }
  const metadata = await readMetadata(token, deps);
  if (
    metadata === null ||
    metadata.decimals !== token.decimals ||
    metadata.name !== token.name ||
    metadata.symbol !== token.symbol
  ) {
    throw new TokenDeployError("token_metadata_mismatch");
  }
  await assertAdminMints(token, deps);

  const extendTo = Math.min(TOKEN_TTL_LEDGERS, ledger.maxEntryTtl - 1);
  const footprint = new SorobanDataBuilder()
    .setReadOnly([instanceKey(token), codeKey(token)])
    .build();
  await submit(admin, deps, Operation.extendFootprintTtl({ extendTo }), footprint);
  return token.contract;
}
