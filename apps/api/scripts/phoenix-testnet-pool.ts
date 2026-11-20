// The project's own testnet Phoenix pool (contract-registry.json, testnet `phoenix` / `pool` and
// `stake`): a pool and stake running the same code as a registered mainnet pool, its test token
// LWPHX, and its seed liquidity. Testnet only, and idempotent: every address follows from the
// token admin, a fixed salt and the network, so a run creates only what is missing and a run after
// a testnet reset brings back the same addresses.
//
//   PHOENIX_TESTNET_TOKEN_ADMIN_SECRET=... bun run phoenix:testnet-pool          create what is missing, then extend
//   bun run phoenix:testnet-pool --extend-only                                    extend the TTLs only, no secret read
//
// The token admin signs the creation, the token's initialization and the seed mint. A Friendbot
// throwaway, printed by its public key only, provides the seed liquidity and pays every TTL
// extension. Nothing here ever signs or submits on mainnet: mainnet is read only for code that
// testnet does not hold yet, by its hash.
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
import { RPC_URLS } from "@/config/networks";
import { entriesForProtocol } from "@/lib/contract-registry";

/** Where the token admin's secret lives, for this script and the funded integration tests. */
export const ADMIN_SECRET_ENV = "PHOENIX_TESTNET_TOKEN_ADMIN_SECRET";

/** The token admin: LWPHX's admin, the pool's admin and fee recipient, and the stake's manager. */
export const PHOENIX_TESTNET_ADMIN = "GAJGBBOFDCIO4DAWLJJDYGCSBBM5NLXYSQMNF3V7LRMTW5S6DUGHXOAV";

/** The mainnet pool and stake whose registered code the testnet pool and stake run: the v1 pool
 *  code's representative and the stake its own CONFIG names. */
export const REFERENCE_MAINNET_POOL = "CB5QUVK5GS3IU23TMFZQ3P5J24YBBZP5PHUQAEJ2SP5K55PFTJRUQG2L";
export const REFERENCE_MAINNET_STAKE = "CDBMVFP7KJXW3YEFSLOU5GYUQHHJJI7QPZJPCSPDK6HHBCBZAMCHS2QY";

/** LWPHX's code: the SEP-41 token code the old testnet token and the mainnet v1 pools' first share
 *  tokens run. It predates constructors, so it is initialized in a call of its own. */
export const LWPHX_WASM_HASH = "f55016cec9190712a7e5e58e09087bcc899393eb0d99353a5fece47bb790a7fb";

/** The share token code the mainnet Phoenix factory CB4SVAWJ… deploys pools with today
 *  (`token_wasm_hash` in its `get_config`, read 2026-11-18). The v1 pool's constructor creates its
 *  share token with constructor arguments, which only this later build accepts. */
export const LP_SHARE_WASM_HASH =
  "36569aa188be6573d60a3c3e2ebf61d4dfb9790b08d8607af4c09108b73007bd";

/** The registry's testnet Phoenix factory, which the pool names as its factory and its stake's
 *  owner. Neither calls it. */
export const TESTNET_FACTORY = "CB7UHVINMUGNHPEFSJYTIIF67ETZAOCVHTBY7XFN5TVKNAWOMVNYIIWW";

/** Native XLM's asset contract on testnet: the pool's token_b. */
export const TESTNET_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** sha256("lumenwipe/phoenix-testnet/lwphx/v1") and sha256("lumenwipe/phoenix-testnet/pool/v1"). */
export const LWPHX_SALT = "f505695d5b180944f2dbe51844e604c35b683850b17a3d9b72ebbcf2612f91b3";
export const POOL_SALT = "6f120c843643eeef49dbb78d7c837c9d6fb11bd0991e545397ff86ee8a2d9201";

export const LWPHX = {
  name: "LumenWipe Phoenix Test Token",
  symbol: "LWPHX",
  decimals: 7,
} as const;

export const SHARE_TOKEN = { name: "LumenWipe Phoenix LP", symbol: "LWPHXLP" } as const;

/** The pool's terms: the old testnet pool's, which the playground's swap and deposit bounds use. */
export const POOL_TERMS = {
  swapFeeBps: 30,
  maxAllowedFeeBps: 100,
  defaultSlippageBps: 100,
  maxAllowedSlippageBps: 500,
  maxAllowedSpreadBps: 500,
  maxReferralBps: 500,
  minBond: BigInt(1),
  minReward: BigInt(1),
  maxComplexity: 10,
} as const;

/** What the seed deposits on each side, in base units: 1,000 LWPHX against 1,000 XLM. */
export const SEED_AMOUNT = BigInt(10_000_000_000);

/** About 30 days of ledgers, what each run extends every entry to (or the network's maximum). */
export const TTL_LEDGERS = 518_400;

/** The most one transaction here may pay, in stroops: 100 XLM. The first extension of the whole
 *  set to `TTL_LEDGERS` is the largest, rent on four contract codes; a daily run pays a day's. */
export const FEE_CAP_STROOPS = BigInt(1_000_000_000);

export class PhoenixTestnetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoenixTestnetError";
  }
}

/** The contract a `createContract` from `deployer` with `saltHex` makes on the network `passphrase`
 *  names. */
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

export const LWPHX_CONTRACT = contractIdFor(PHOENIX_TESTNET_ADMIN, LWPHX_SALT, Networks.TESTNET);
export const POOL_CONTRACT = contractIdFor(PHOENIX_TESTNET_ADMIN, POOL_SALT, Networks.TESTNET);

/** The pool and stake code hashes, read from the registry's verifiedLive mainnet entries. */
export function referenceCodes(): { pool: string; stake: string } {
  const phoenix = entriesForProtocol("mainnet", "phoenix");
  const hashOf = (address: string, kind: "pool" | "stake"): string => {
    const entry = phoenix.find((e) => e.address === address && e.kind === kind);
    if (!entry?.verifiedLive || !entry.wasmHash)
      throw new PhoenixTestnetError("reference_unlisted");
    return entry.wasmHash;
  };
  return {
    pool: hashOf(REFERENCE_MAINNET_POOL, "pool"),
    stake: hashOf(REFERENCE_MAINNET_STAKE, "stake"),
  };
}

/** The admin's key from `secret`, or null when it is missing, unreadable or any other key. */
export function adminKeypair(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  try {
    const keypair = Keypair.fromSecret(secret);
    return keypair.publicKey() === PHOENIX_TESTNET_ADMIN ? keypair : null;
  } catch {
    return null;
  }
}

type TestnetRpc = Pick<
  rpc.Server,
  "getNetwork" | "getLedgerEntries" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

export interface PhoenixTestnetDeps {
  rpc: TestnetRpc;
  /** Read only, for code testnet does not hold yet. */
  mainnetRpc: Pick<rpc.Server, "getLedgerEntries">;
  loadSequence: (address: string) => Promise<string>;
  /** Funds a fresh account through Friendbot. */
  fund: (address: string) => Promise<void>;
  newKeypair: () => Keypair;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

export const defaultDeps = (): PhoenixTestnetDeps => ({
  rpc: new rpc.Server(RPC_URLS.testnet),
  mainnetRpc: new rpc.Server(RPC_URLS.mainnet),
  loadSequence: async (address) => {
    const res = await fetch(`${HORIZON_TESTNET}/accounts/${encodeURIComponent(address)}`);
    if (!res.ok) throw new PhoenixTestnetError(`account_unreadable: ${res.status}`);
    return ((await res.json()) as { sequence: string }).sequence;
  },
  fund: async (address) => {
    const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
    if (!res.ok) throw new PhoenixTestnetError(`friendbot_failed: ${res.status}`);
  },
  newKeypair: () => Keypair.random(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log: (line) => process.stdout.write(`${line}\n`),
});

/** Refuses anything but testnet, by the passphrase the RPC itself reports. */
export async function assertTestnet(deps: Pick<PhoenixTestnetDeps, "rpc">): Promise<void> {
  const { passphrase } = await deps.rpc.getNetwork();
  if (passphrase !== Networks.TESTNET) throw new PhoenixTestnetError("not_testnet");
}

export const instanceKey = (contract: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    })
  );

const persistentKey = (contract: string, key: xdr.ScVal): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    })
  );

export const codeKey = (wasmHash: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, "hex") }));

const configKey = (contract: string): xdr.LedgerKey =>
  persistentKey(contract, xdr.ScVal.scvSymbol("CONFIG"));

const balanceKey = (token: string, holder: string): xdr.LedgerKey =>
  persistentKey(
    token,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(holder).toScVal()])
  );

const archivalKey = (): xdr.LedgerKey =>
  xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
    })
  );

export const b64 = (key: xdr.LedgerKey): string => key.toXDR("base64");

/** What a contract address holds: nothing, the expected code as a Wasm executable, or anything
 *  else (another hash, a CAP-85 external reference, a Stellar asset). */
export type InstanceState = "missing" | "expected" | "other";

export function instanceState(
  data: xdr.LedgerEntryData | undefined,
  wasmHash: string
): InstanceState {
  if (data === undefined) return "missing";
  const val = data.type === "contractData" ? data.contractData.val : null;
  const executable = val?.type === "scvContractInstance" ? val.instance.executable : null;
  return executable?.type === "contractExecutableWasm" &&
    executable.wasmHash.toXDR("hex") === wasmHash
    ? "expected"
    : "other";
}

/** The pool's CONFIG fields this script relies on. */
export interface PoolConfig {
  tokenA: string;
  tokenB: string;
  shareToken: string;
  stakeContract: string;
}

function poolConfigOf(data: xdr.LedgerEntryData | undefined): PoolConfig | null {
  const val = data?.type === "contractData" ? data.contractData.val : null;
  if (val?.type !== "scvMap") return null;
  const native = scValToNative(val) as Record<string, unknown>;
  const fields = [native.token_a, native.token_b, native.share_token, native.stake_contract];
  if (!fields.every((f) => typeof f === "string" && StrKey.isValidContract(f))) return null;
  const [tokenA, tokenB, shareToken, stakeContract] = fields as string[];
  return {
    tokenA: tokenA!,
    tokenB: tokenB!,
    shareToken: shareToken!,
    stakeContract: stakeContract!,
  };
}

export async function entries(
  reader: Pick<rpc.Server, "getLedgerEntries">,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const res = await reader.getLedgerEntries(...keys);
  return new Map(res.entries.map((e) => [b64(e.key), e.val]));
}

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

/** Simulates, checks what came back, signs with `signer` alone and waits for the result. Every
 *  authorization must be the signer's own source-account credential. */
async function submit(
  signer: Keypair,
  deps: PhoenixTestnetDeps,
  op: xdr.Operation,
  sorobanData?: xdr.SorobanTransactionData
): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const built = buildTx(
    signer.publicKey(),
    await deps.loadSequence(signer.publicKey()),
    op,
    sorobanData
  );
  const sim = await deps.rpc.simulateTransaction(built);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new PhoenixTestnetError("simulation_failed");
  if (rpc.Api.isSimulationRestore(sim)) throw new PhoenixTestnetError("simulation_needs_restore");
  const assembled = rpc.assembleTransaction(built, sim).build();
  const [assembledOp] = assembled.operations;
  if (
    assembled.operations.length !== 1 ||
    assembled.source !== signer.publicKey() ||
    assembledOp?.type !== built.operations[0]?.type
  ) {
    throw new PhoenixTestnetError("assembled_operation_changed");
  }
  if (assembledOp.type === "invokeHostFunction") {
    for (const entry of assembledOp.auth ?? []) {
      if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
        throw new PhoenixTestnetError("auth_credentials_not_source");
      }
    }
  }
  if (BigInt(assembled.fee) > FEE_CAP_STROOPS) {
    throw new PhoenixTestnetError(`fee_above_cap: ${assembled.fee}`);
  }
  assembled.sign(signer);
  const sent = await deps.rpc.sendTransaction(assembled);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new PhoenixTestnetError(`send_rejected: ${sent.status}`);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await deps.rpc.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      deps.log(`  submitted ${sent.hash} for ${assembled.fee} stroops`);
      return sim;
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new PhoenixTestnetError(`transaction_failed: ${sent.hash}`);
    }
    await deps.sleep(1_000);
  }
  throw new PhoenixTestnetError(`transaction_timeout: ${sent.hash}`);
}

/** A read-only call's result, simulated from a source that need not exist. */
async function readCall(
  deps: Pick<PhoenixTestnetDeps, "rpc">,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const tx = buildTx(PHOENIX_TESTNET_ADMIN, "0", new Contract(contract).call(fn, ...args));
  const sim = await deps.rpc.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
  return scValToNative(sim.result.retval);
}

/**
 * Proves the pinned admin controls LWPHX: a simulated `mint` sent by it records only its own
 * source-account authorization. A token someone else initialized first records theirs instead.
 */
async function assertAdminMints(deps: Pick<PhoenixTestnetDeps, "rpc">): Promise<void> {
  const mint = new Contract(LWPHX_CONTRACT).call(
    "mint",
    addr(PHOENIX_TESTNET_ADMIN),
    i128(BigInt(1))
  );
  const sim = await deps.rpc.simulateTransaction(buildTx(PHOENIX_TESTNET_ADMIN, "0", mint));
  const auth = rpc.Api.isSimulationSuccess(sim) ? (sim.result?.auth ?? []) : [];
  if (
    auth.length !== 1 ||
    !auth.every((entry) => entry.credentials.type === "sorobanCredentialsSourceAccount")
  ) {
    throw new PhoenixTestnetError("admin_not_in_control");
  }
}

/** Puts `wasmHash` on testnet if it is not there: read by hash from mainnet, where the registry
 *  verified it, and uploaded only when the bytes hash to it. */
async function ensureCode(
  admin: Keypair,
  deps: PhoenixTestnetDeps,
  wasmHash: string,
  live: Map<string, xdr.LedgerEntryData>
): Promise<void> {
  if (live.has(b64(codeKey(wasmHash)))) return;
  const mainnet = (await entries(deps.mainnetRpc, [codeKey(wasmHash)])).get(b64(codeKey(wasmHash)));
  if (mainnet?.type !== "contractCode") throw new PhoenixTestnetError("code_not_on_mainnet");
  const code = Buffer.from(mainnet.contractCode.code);
  if (Buffer.from(hash(code)).toString("hex") !== wasmHash) {
    throw new PhoenixTestnetError("code_hash_mismatch");
  }
  deps.log(`uploading code ${wasmHash}`);
  await submit(admin, deps, Operation.uploadContractWasm({ wasm: code }));
}

const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
const i64 = (v: number): xdr.ScVal => nativeToScVal(v, { type: "i64" });
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const struct = (fields: Record<string, xdr.ScVal>): xdr.ScVal =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! }))
  );

/** The pool's `__constructor` arguments, as the mainnet v1 pool code declares them. */
export function poolConstructorArgs(codes: { stake: string }): xdr.ScVal[] {
  return [
    xdr.ScVal.scvBytes(Buffer.from(codes.stake, "hex")),
    xdr.ScVal.scvBytes(Buffer.from(LP_SHARE_WASM_HASH, "hex")),
    struct({
      admin: addr(PHOENIX_TESTNET_ADMIN),
      default_slippage_bps: i64(POOL_TERMS.defaultSlippageBps),
      fee_recipient: addr(PHOENIX_TESTNET_ADMIN),
      max_allowed_slippage_bps: i64(POOL_TERMS.maxAllowedSlippageBps),
      max_allowed_spread_bps: i64(POOL_TERMS.maxAllowedSpreadBps),
      max_referral_bps: i64(POOL_TERMS.maxReferralBps),
      stake_init_info: struct({
        manager: addr(PHOENIX_TESTNET_ADMIN),
        max_complexity: nativeToScVal(POOL_TERMS.maxComplexity, { type: "u32" }),
        min_bond: i128(POOL_TERMS.minBond),
        min_reward: i128(POOL_TERMS.minReward),
      }),
      swap_fee_bps: i64(POOL_TERMS.swapFeeBps),
      token_init_info: struct({ token_a: addr(LWPHX_CONTRACT), token_b: addr(TESTNET_XLM_SAC) }),
    }),
    addr(TESTNET_FACTORY),
    nativeToScVal(SHARE_TOKEN.name, { type: "string" }),
    nativeToScVal(SHARE_TOKEN.symbol, { type: "string" }),
    i64(POOL_TERMS.defaultSlippageBps),
    i64(POOL_TERMS.maxAllowedFeeBps),
  ];
}

/** Whether `a` sorts below `b` as the pool compares its tokens, by their contract ids. */
export const sortsBelow = (a: string, b: string): boolean =>
  Buffer.compare(StrKey.decodeContract(a), StrKey.decodeContract(b)) < 0;

/** The deployed set as the ledger holds it, or why it is not whole. */
export interface PhoenixTestnetSet {
  pool: string;
  stake: string;
  shareToken: string;
  tokenA: string;
  tokenB: string;
}

/** Reads the pool, its CONFIG and what it names, and holds each to the code it must run. */
async function readSet(
  deps: Pick<PhoenixTestnetDeps, "rpc">,
  codes: { pool: string; stake: string }
): Promise<PhoenixTestnetSet> {
  const first = await entries(deps.rpc, [instanceKey(POOL_CONTRACT), configKey(POOL_CONTRACT)]);
  const pool = instanceState(first.get(b64(instanceKey(POOL_CONTRACT))), codes.pool);
  if (pool !== "expected") throw new PhoenixTestnetError(`pool_${pool}`);
  const config = poolConfigOf(first.get(b64(configKey(POOL_CONTRACT))));
  if (!config) throw new PhoenixTestnetError("pool_config_unreadable");
  if (config.tokenA !== LWPHX_CONTRACT || config.tokenB !== TESTNET_XLM_SAC) {
    throw new PhoenixTestnetError("pool_tokens_unexpected");
  }
  const second = await entries(deps.rpc, [
    instanceKey(config.stakeContract),
    instanceKey(config.shareToken),
    instanceKey(LWPHX_CONTRACT),
  ]);
  const expect = (contract: string, wasmHash: string, what: string) => {
    const state = instanceState(second.get(b64(instanceKey(contract))), wasmHash);
    if (state !== "expected") throw new PhoenixTestnetError(`${what}_${state}`);
  };
  expect(config.stakeContract, codes.stake, "stake");
  expect(config.shareToken, LP_SHARE_WASM_HASH, "share_token");
  expect(LWPHX_CONTRACT, LWPHX_WASM_HASH, "lwphx");
  return {
    pool: POOL_CONTRACT,
    stake: config.stakeContract,
    shareToken: config.shareToken,
    tokenA: config.tokenA,
    tokenB: config.tokenB,
  };
}

/**
 * Extends every entry the pinned pool needs to stay usable: the four instances, the four codes,
 * the pool's and the stake's CONFIG, the pool's reserves, and the pool's balances on both tokens.
 * Only entries that exist are extended. Needs no secret: a Friendbot throwaway pays.
 */
export async function extendTtl(
  deps: PhoenixTestnetDeps,
  codes: { pool: string; stake: string } = referenceCodes()
): Promise<PhoenixTestnetSet> {
  await assertTestnet(deps);
  const set = await readSet(deps, codes);
  const candidates = [
    instanceKey(set.pool),
    instanceKey(set.stake),
    instanceKey(set.shareToken),
    instanceKey(set.tokenA),
    codeKey(codes.pool),
    codeKey(codes.stake),
    codeKey(LWPHX_WASM_HASH),
    codeKey(LP_SHARE_WASM_HASH),
    configKey(set.pool),
    configKey(set.stake),
    persistentKey(set.pool, xdr.ScVal.scvU32(1)),
    persistentKey(set.pool, xdr.ScVal.scvU32(2)),
    balanceKey(set.tokenA, set.pool),
    balanceKey(set.tokenB, set.pool),
  ];
  await extendFootprint(deps, candidates);
  return set;
}

/**
 * Extends every one of `candidates` that exists to `TTL_LEDGERS` (or the network's maximum) in one
 * transaction, which a funded Friendbot throwaway pays. Returns the keys it extended.
 */
export async function extendFootprint(
  deps: PhoenixTestnetDeps,
  candidates: xdr.LedgerKey[]
): Promise<xdr.LedgerKey[]> {
  const live = await entries(deps.rpc, [...candidates, archivalKey()]);
  const archival = live.get(b64(archivalKey()));
  if (
    archival?.type !== "configSetting" ||
    archival.configSetting.type !== "configSettingStateArchival"
  ) {
    throw new PhoenixTestnetError("ledger_unreadable");
  }
  const present = candidates.filter((k) => live.has(b64(k)));
  const extendTo = Math.min(
    TTL_LEDGERS,
    archival.configSetting.stateArchivalSettings.maxEntryTtl - 1
  );
  const payer = deps.newKeypair();
  deps.log(`extending ${present.length} entries with throwaway ${payer.publicKey()}`);
  await deps.fund(payer.publicKey());
  await submit(
    payer,
    deps,
    Operation.extendFootprintTtl({ extendTo }),
    new SorobanDataBuilder().setReadOnly(present).build()
  );
  return present;
}

/**
 * Creates whatever of the set is missing, seeds an empty pool, then extends every TTL. Refuses
 * anything but testnet and any address that runs other code. `admin` is the key `adminKeypair`
 * accepted; another key would only fail the pinned addresses' authorization.
 */
export async function ensurePhoenixTestnet(
  admin: Keypair,
  deps: PhoenixTestnetDeps,
  codes: { pool: string; stake: string } = referenceCodes()
): Promise<PhoenixTestnetSet> {
  await assertTestnet(deps);
  if (!sortsBelow(LWPHX_CONTRACT, TESTNET_XLM_SAC)) {
    throw new PhoenixTestnetError("token_order_unexpected");
  }

  const live = await entries(deps.rpc, [
    codeKey(codes.pool),
    codeKey(codes.stake),
    codeKey(LWPHX_WASM_HASH),
    codeKey(LP_SHARE_WASM_HASH),
    instanceKey(LWPHX_CONTRACT),
    instanceKey(POOL_CONTRACT),
  ]);
  const token = instanceState(live.get(b64(instanceKey(LWPHX_CONTRACT))), LWPHX_WASM_HASH);
  const pool = instanceState(live.get(b64(instanceKey(POOL_CONTRACT))), codes.pool);
  if (token === "other") throw new PhoenixTestnetError("lwphx_other");
  if (pool === "other") throw new PhoenixTestnetError("pool_other");
  for (const code of [codes.pool, codes.stake, LWPHX_WASM_HASH, LP_SHARE_WASM_HASH]) {
    await ensureCode(admin, deps, code, live);
  }

  if (token === "missing") {
    deps.log(`creating LWPHX ${LWPHX_CONTRACT}`);
    await submit(
      admin,
      deps,
      Operation.createCustomContract({
        address: Address.fromString(PHOENIX_TESTNET_ADMIN),
        wasmHash: Buffer.from(LWPHX_WASM_HASH, "hex"),
        salt: Buffer.from(LWPHX_SALT, "hex"),
      })
    );
  }
  if ((await readCall(deps, LWPHX_CONTRACT, "decimals")) === undefined) {
    deps.log("initializing LWPHX");
    await submit(
      admin,
      deps,
      new Contract(LWPHX_CONTRACT).call(
        "initialize",
        addr(PHOENIX_TESTNET_ADMIN),
        nativeToScVal(LWPHX.decimals, { type: "u32" }),
        nativeToScVal(LWPHX.name, { type: "string" }),
        nativeToScVal(LWPHX.symbol, { type: "string" })
      )
    );
  }
  if (
    (await readCall(deps, LWPHX_CONTRACT, "symbol")) !== LWPHX.symbol ||
    (await readCall(deps, LWPHX_CONTRACT, "decimals")) !== LWPHX.decimals
  ) {
    throw new PhoenixTestnetError("lwphx_metadata_unexpected");
  }
  await assertAdminMints(deps);

  if (pool === "missing") {
    deps.log(`creating the pool ${POOL_CONTRACT}`);
    await submit(
      admin,
      deps,
      Operation.createCustomContract({
        address: Address.fromString(PHOENIX_TESTNET_ADMIN),
        wasmHash: Buffer.from(codes.pool, "hex"),
        salt: Buffer.from(POOL_SALT, "hex"),
        constructorArgs: poolConstructorArgs(codes),
      })
    );
  }
  const set = await readSet(deps, codes);

  const info = (await readCall(deps, POOL_CONTRACT, "query_pool_info")) as
    { asset_a: { amount: bigint }; asset_b: { amount: bigint } } | undefined;
  if (!info) throw new PhoenixTestnetError("pool_unreadable");
  if (info.asset_a.amount === BigInt(0) && info.asset_b.amount === BigInt(0)) {
    const seeder = deps.newKeypair();
    deps.log(`seeding from throwaway ${seeder.publicKey()}`);
    await deps.fund(seeder.publicKey());
    await submit(
      admin,
      deps,
      new Contract(LWPHX_CONTRACT).call("mint", addr(seeder.publicKey()), i128(SEED_AMOUNT))
    );
    await submit(
      seeder,
      deps,
      new Contract(POOL_CONTRACT).call(
        "provide_liquidity",
        addr(seeder.publicKey()),
        i128(SEED_AMOUNT),
        i128(SEED_AMOUNT),
        i128(SEED_AMOUNT),
        i128(SEED_AMOUNT),
        xdr.ScVal.scvVoid(),
        xdr.ScVal.scvVoid(),
        xdr.ScVal.scvBool(false)
      )
    );
  }

  await extendTtl(deps, codes);
  return set;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  deps: PhoenixTestnetDeps = defaultDeps()
): Promise<number> {
  const extendOnly = argv.includes("--extend-only");
  try {
    let set: PhoenixTestnetSet;
    if (extendOnly) {
      set = await extendTtl(deps);
    } else {
      const admin = adminKeypair(env[ADMIN_SECRET_ENV]);
      if (!admin) {
        process.stderr.write(
          `Refused: ${ADMIN_SECRET_ENV} must hold the secret key of ${PHOENIX_TESTNET_ADMIN}.\n`
        );
        return 1;
      }
      set = await ensurePhoenixTestnet(admin, deps);
    }
    deps.log(JSON.stringify(set, null, 2));
    return 0;
  } catch (err) {
    const reason = err instanceof PhoenixTestnetError ? err.message : String(err);
    process.stderr.write(`The testnet Phoenix pool was not ensured: ${reason}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
