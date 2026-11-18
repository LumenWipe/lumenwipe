import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  scValToNative,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { entriesForProtocol } from "@/lib/contract-registry";
import { v1TransactionFromXdr } from "../support/v1-transaction";
import {
  adminKeypair,
  ensurePhoenixTestnet,
  extendTtl,
  LWPHX_CONTRACT,
  LWPHX_SALT,
  main,
  PHOENIX_TESTNET_ADMIN,
  PhoenixTestnetError,
  POOL_CONTRACT,
  POOL_SALT,
  poolConstructorArgs,
  referenceCodes,
  LP_SHARE_WASM_HASH,
  sortsBelow,
  TESTNET_XLM_SAC,
  LWPHX_WASM_HASH,
  TTL_LEDGERS,
  type PhoenixTestnetDeps,
} from "../../scripts/phoenix-testnet-pool";

// The testnet Phoenix pool's deployment script against a fake ledger. No key here is the real
// admin's: every signer is generated per run, and the fake answers for whoever signs.

/** The state archival settings testnet returned on 2026-11-18: a maximum entry TTL of 3,110,400. */
const ARCHIVAL = xdr.LedgerEntryData.fromXDR(
  "AAAACAAAAAoAL3YAAAAC0AAB2IAAAAAAAAAEvwAAAAAAAAl+AAAD6AAAAB4AAABAAAehIAAAAAc=",
  "base64"
);

const contractId = (): string => StrKey.encodeContract(randomBytes(32));
const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

interface Codes {
  pool: string;
  stake: string;
}

interface Ledger {
  /** Contract id to the code its instance runs, or an executable that is not that code. */
  instances: Map<string, string | xdr.ContractExecutable>;
  /** Code hashes testnet holds. */
  codes: Set<string>;
  /** The pool's CONFIG, once the pool exists. */
  config: { stake: string; share: string; tokenA: string; tokenB: string } | null;
  reserves: [bigint, bigint];
  lwphxInitialized: boolean;
  passphrase: string;
}

interface Sent {
  kind: string;
  signer: string;
  footprint?: number;
  extendTo?: number;
  wasm?: string;
}

const dataEntry = (contract: string, key: xdr.ScVal, val: xdr.ScVal): xdr.LedgerEntryData =>
  xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
      val,
    })
  );

const instanceVal = (code: string | xdr.ContractExecutable): xdr.ScVal =>
  xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable:
        typeof code === "string"
          ? xdr.ContractExecutable.contractExecutableWasm(Buffer.from(code, "hex"))
          : code,
      storage: null,
    })
  );

const configVal = (c: NonNullable<Ledger["config"]>): xdr.ScVal =>
  xdr.ScVal.scvMap(
    (
      [
        ["share_token", c.share],
        ["stake_contract", c.stake],
        ["token_a", c.tokenA],
        ["token_b", c.tokenB],
      ] as const
    ).map(
      ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: new Address(v).toScVal() })
    )
  );

function success(
  retval: xdr.ScVal | null,
  auth: xdr.SorobanAuthorizationEntry[] = [],
  fee = "50000"
): rpc.Api.SimulateTransactionResponse {
  return rpc.parseRawSimulation({
    id: "1",
    latestLedger: 100,
    transactionData: new SorobanDataBuilder().setResourceFee(fee).build().toXDR("base64"),
    minResourceFee: fee,
    ...(retval
      ? { results: [{ auth: auth.map((a) => a.toXDR("base64")), xdr: retval.toXDR("base64") }] }
      : {}),
    events: [],
  });
}

const sourceAuth = (contract: string, fn: string): xdr.SorobanAuthorizationEntry =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });

/** The Soroban data a transaction carries. */
function sorobanDataOf(tx: Transaction): xdr.SorobanTransactionData {
  const v1 = v1TransactionFromXdr(tx.toXDR());
  if (v1.ext.type !== "sorobanData") throw new Error("no soroban data");
  return v1.ext.sorobanData;
}

function kindOf(tx: Transaction): string {
  const op = tx.operations[0];
  if (op?.type === "extendFootprintTtl") return "extend";
  if (op?.type !== "invokeHostFunction") return "other";
  if (op.func.type === "hostFunctionTypeInvokeContract") {
    return op.func.invokeContract.functionName.toString();
  }
  if (op.func.type === "hostFunctionTypeUploadContractWasm") return "upload";
  return "create";
}

/** The fake: one testnet ledger and a mainnet that holds `mainnetCode` by the hash it claims. */
function fake(ledger: Ledger, mainnetCode = new Map<string, Buffer>()) {
  const sent: Sent[] = [];
  const funded: string[] = [];
  const touched: string[] = [];
  let last: Transaction | null = null;
  const entryFor = (key: xdr.LedgerKey): xdr.LedgerEntryData | null => {
    if (key.type === "configSetting") return ARCHIVAL;
    if (key.type === "contractCode") {
      const hash = Buffer.from(key.contractCode.hash.toBytes()).toString("hex");
      return ledger.codes.has(hash)
        ? xdr.LedgerEntryData.contractCode(
            new xdr.ContractCodeEntry({
              ext: xdr.ContractCodeEntryExt.v0(),
              hash: Buffer.from(hash, "hex"),
              code: Buffer.from([0]),
            })
          )
        : null;
    }
    if (key.type !== "contractData") return null;
    const contract = Address.fromScAddress(key.contractData.contract).toString();
    const k = key.contractData.key;
    if (k.type === "scvLedgerKeyContractInstance") {
      const code = ledger.instances.get(contract);
      return code === undefined ? null : dataEntry(contract, k, instanceVal(code));
    }
    if (k.type === "scvSymbol" && String(k.sym) === "CONFIG") {
      if (contract === POOL_CONTRACT && ledger.config) {
        return dataEntry(contract, k, configVal(ledger.config));
      }
      if (contract === ledger.config?.stake) return dataEntry(contract, k, xdr.ScVal.scvVoid());
    }
    if (k.type === "scvU32" && contract === POOL_CONTRACT && ledger.config) {
      return dataEntry(contract, k, nativeToScVal(ledger.reserves[0], { type: "i128" }));
    }
    return null;
  };
  const server: PhoenixTestnetDeps["rpc"] = {
    getNetwork: async () => ({ passphrase: ledger.passphrase, protocolVersion: "23" }),
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      touched.push("read");
      const entries = keys.flatMap((key) => {
        const val = entryFor(key);
        return val ? [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 200 }] : [];
      });
      return { entries, latestLedger: 100 };
    },
    simulateTransaction: async (tx) => {
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const kind = kindOf(tx);
      if (kind === "decimals") {
        return ledger.lwphxInitialized
          ? success(nativeToScVal(7, { type: "u32" }))
          : rpc.parseRawSimulation({ id: "1", latestLedger: 100, error: "no", events: [] });
      }
      if (kind === "symbol") return success(nativeToScVal("LWPHX", { type: "string" }));
      if (kind === "query_pool_info") {
        const amount = (v: bigint) =>
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("amount"),
              val: nativeToScVal(v, { type: "i128" }),
            }),
          ]);
        return success(
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("asset_a"),
              val: amount(ledger.reserves[0]),
            }),
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("asset_b"),
              val: amount(ledger.reserves[1]),
            }),
          ])
        );
      }
      if (kind === "mint")
        return success(xdr.ScVal.scvVoid(), [sourceAuth(LWPHX_CONTRACT, "mint")]);
      if (kind === "extend") {
        const data = sorobanDataOf(tx);
        return rpc.parseRawSimulation({
          id: "1",
          latestLedger: 100,
          transactionData: new SorobanDataBuilder(data)
            .setResourceFee("50000")
            .build()
            .toXDR("base64"),
          minResourceFee: "50000",
          events: [],
        });
      }
      return success(xdr.ScVal.scvVoid());
    },
    sendTransaction: async (tx) => {
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const op = tx.operations[0];
      const kind = kindOf(tx);
      sent.push({
        kind,
        signer: tx.source,
        ...(op?.type === "extendFootprintTtl"
          ? {
              extendTo: op.extendTo,
              footprint: sorobanDataOf(tx).resources.footprint.readOnly.length,
            }
          : {}),
        ...(op?.type === "invokeHostFunction" &&
        op.func.type === "hostFunctionTypeUploadContractWasm"
          ? { wasm: sha256(Buffer.from(op.func.wasm)) }
          : {}),
      });
      last = tx;
      return {
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 1,
        latestLedgerCloseTime: 0,
      };
    },
    getTransaction: async (hash) => {
      const window = {
        txHash: hash,
        latestLedger: 2,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      };
      return {
        ...window,
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1,
        createdAt: 0,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: last!.toEnvelope(),
        resultXdr: new xdr.TransactionResult({
          feeCharged: BigInt(100),
          result: xdr.TransactionResultResult.txSuccess([]),
          ext: xdr.TransactionResultExt.v0(),
        }),
        resultMetaXdr: xdr.TransactionMeta.operations([]),
        events: { transactionEventsXdr: [], contractEventsXdr: [] },
      };
    },
  };
  const deps: PhoenixTestnetDeps = {
    rpc: server,
    mainnetRpc: {
      getLedgerEntries: async (...keys: xdr.LedgerKey[]) => ({
        latestLedger: 100,
        entries: keys.flatMap((key) => {
          if (key.type !== "contractCode") return [];
          const hash = Buffer.from(key.contractCode.hash.toBytes()).toString("hex");
          const code = mainnetCode.get(hash);
          if (!code) return [];
          const val = xdr.LedgerEntryData.contractCode(
            new xdr.ContractCodeEntry({
              ext: xdr.ContractCodeEntryExt.v0(),
              hash: Buffer.from(hash, "hex"),
              code,
            })
          );
          return [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 200 }];
        }),
      }),
    },
    loadSequence: async () => "41",
    fund: async (address) => {
      funded.push(address);
    },
    newKeypair: () => Keypair.random(),
    sleep: async () => {},
    log: () => {},
  };
  return { deps, sent, funded, touched };
}

/** The whole set deployed, as a run after the first finds it. */
function deployed(codes: Codes, over: Partial<Ledger> = {}): Ledger {
  const stake = contractId();
  const share = contractId();
  return {
    instances: new Map<string, string | xdr.ContractExecutable>([
      [POOL_CONTRACT, codes.pool],
      [stake, codes.stake],
      [share, LP_SHARE_WASM_HASH],
      [LWPHX_CONTRACT, LWPHX_WASM_HASH],
    ]),
    codes: new Set([codes.pool, codes.stake, LWPHX_WASM_HASH, LP_SHARE_WASM_HASH]),
    config: { stake, share, tokenA: LWPHX_CONTRACT, tokenB: TESTNET_XLM_SAC },
    reserves: [BigInt(10_000_000_000), BigInt(10_000_000_000)],
    lwphxInitialized: true,
    passphrase: Networks.TESTNET,
    ...over,
  };
}

const randomCodes = (): Codes => ({
  pool: randomBytes(32).toString("hex"),
  stake: randomBytes(32).toString("hex"),
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ensured";
  } catch (err) {
    if (err instanceof PhoenixTestnetError) return err.message;
    throw err;
  }
}

/** An environment that fails the test the moment anything reads from it. */
const untouchableEnv = (): Record<string, string | undefined> =>
  new Proxy<Record<string, string | undefined>>(
    {},
    {
      get(_target, key) {
        throw new Error(`the environment was read: ${String(key)}`);
      },
    }
  );

describe("the pinned set", () => {
  test("its salts are the sha256 of their labels, and the addresses follow from the admin and them", () => {
    expect(LWPHX_SALT).toBe(sha256("lumenwipe/phoenix-testnet/lwphx/v1"));
    expect(POOL_SALT).toBe(sha256("lumenwipe/phoenix-testnet/pool/v1"));
    expect(LWPHX_CONTRACT).toBe("CBQP4F36A7N4QAOEM6MAWBWU52WN6RBN2CIS5EO7H542CX2AFXP5VL4Y");
    expect(POOL_CONTRACT).toBe("CA4V7YVUC3EE2EFVTEYJ47ZD34K4DCAKEYV6AHRR73KTKO5GDGNZLLMT");
  });

  test("LWPHX sorts below XLM's asset contract, as the pool requires of token_a", () => {
    expect(sortsBelow(LWPHX_CONTRACT, TESTNET_XLM_SAC)).toBe(true);
    expect(sortsBelow(TESTNET_XLM_SAC, LWPHX_CONTRACT)).toBe(false);
  });

  test("the codes come from verifiedLive mainnet entries, and the registry's testnet pool and stake run them", () => {
    const codes = referenceCodes();
    const testnet = entriesForProtocol("testnet", "phoenix");
    const pool = testnet.find((e) => e.kind === "pool");
    const stake = testnet.find((e) => e.kind === "stake");
    expect(pool).toMatchObject({ address: POOL_CONTRACT, wasmHash: codes.pool });
    expect(stake?.wasmHash).toBe(codes.stake);
  });

  test("the pool's constructor names LWPHX and XLM in order, the mainnet stake code and the share token code", () => {
    const codes = randomCodes();
    const [stakeHash, tokenHash, info] = poolConstructorArgs(codes);
    const hex = (v: xdr.ScVal | undefined) =>
      Buffer.from(scValToNative(v!) as Buffer).toString("hex");
    expect(hex(stakeHash)).toBe(codes.stake);
    expect(hex(tokenHash)).toBe(LP_SHARE_WASM_HASH);
    const fields =
      info?.type === "scvMap"
        ? (info.map ?? []).map((e) => (e.key.type === "scvSymbol" ? String(e.key.sym) : ""))
        : [];
    expect(fields).toEqual([...fields].sort());
    const native: { token_init_info: { token_a: string; token_b: string } } = scValToNative(info!);
    expect(native.token_init_info).toEqual({ token_a: LWPHX_CONTRACT, token_b: TESTNET_XLM_SAC });
  });
});

describe("the admin key", () => {
  test("only the pinned admin's secret is accepted", () => {
    expect(adminKeypair(undefined)).toBeNull();
    expect(adminKeypair("")).toBeNull();
    expect(adminKeypair("not a key")).toBeNull();
    expect(adminKeypair(Keypair.random().secret())).toBeNull();
  });

  test("a run that would create without the admin's secret refuses before touching the network", async () => {
    const f = fake(deployed(randomCodes()));
    expect(await main([], {}, f.deps)).toBe(1);
    expect(
      await main([], { PHOENIX_TESTNET_TOKEN_ADMIN_SECRET: Keypair.random().secret() }, f.deps)
    ).toBe(1);
    expect(f.touched).toEqual([]);
    expect(f.sent).toEqual([]);
  });
});

describe("the extend-only mode", () => {
  test("reads no secret, creates nothing, and extends the whole set from a funded throwaway", async () => {
    const f = fake(deployed(referenceCodes()));
    expect(await main(["--extend-only"], untouchableEnv(), f.deps)).toBe(0);
    expect(f.sent).toHaveLength(1);
    const [extend] = f.sent;
    expect(extend).toMatchObject({ kind: "extend", extendTo: TTL_LEDGERS });
    // Four instances, four codes, the pool's and the stake's CONFIG and the pool's two reserves;
    // the fake holds no token balance for the pool.
    expect(extend!.footprint).toBe(12);
    expect(f.funded).toEqual([extend!.signer]);
    expect(extend!.signer).not.toBe(PHOENIX_TESTNET_ADMIN);
  });

  test("refuses any network but testnet before reading or sending anything", async () => {
    const f = fake(deployed(randomCodes(), { passphrase: Networks.PUBLIC }));
    expect(await refusal(extendTtl(f.deps))).toBe("not_testnet");
    expect(await main(["--extend-only"], untouchableEnv(), f.deps)).toBe(1);
    expect(f.touched).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(f.funded).toEqual([]);
  });

  test("a pool that is missing, or runs other code, is refused and nothing is created", async () => {
    const codes = randomCodes();
    const missing = deployed(codes);
    missing.instances.delete(POOL_CONTRACT);
    const other = deployed(codes);
    other.instances.set(POOL_CONTRACT, randomBytes(32).toString("hex"));
    for (const [ledger, reason] of [
      [missing, "pool_missing"],
      [other, "pool_other"],
    ] as const) {
      const f = fake(ledger);
      expect(await refusal(extendTtl(f.deps, codes))).toBe(reason);
      expect(f.sent).toEqual([]);
    }
  });
});

describe("ensurePhoenixTestnet", () => {
  const admin = Keypair.random();

  test("a run that finds the whole set seeded only extends it", async () => {
    const codes = randomCodes();
    const f = fake(deployed(codes));
    const set = await ensurePhoenixTestnet(admin, f.deps, codes);
    expect(set.pool).toBe(POOL_CONTRACT);
    expect(f.sent.map((s) => s.kind)).toEqual(["extend"]);
  });

  test("refuses any network but testnet before reading anything", async () => {
    const f = fake(deployed(randomCodes(), { passphrase: Networks.PUBLIC }));
    expect(await refusal(ensurePhoenixTestnet(admin, f.deps, randomCodes()))).toBe("not_testnet");
    expect(f.touched).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("an address that runs other code, an external reference included, is never deployed over", async () => {
    const codes = randomCodes();
    const external = xdr.ContractExecutable.contractExecutableStellarAsset();
    for (const [at, code, reason] of [
      [POOL_CONTRACT, randomBytes(32).toString("hex"), "pool_other"],
      [POOL_CONTRACT, external, "pool_other"],
      [LWPHX_CONTRACT, randomBytes(32).toString("hex"), "lwphx_other"],
    ] as const) {
      const ledger = deployed(codes);
      ledger.instances.set(at, code);
      const f = fake(ledger);
      expect(await refusal(ensurePhoenixTestnet(admin, f.deps, codes))).toBe(reason);
      expect(f.sent).toEqual([]);
    }
  });

  test("a stake or share token running other code fails the run before any seeding", async () => {
    const codes = randomCodes();
    const ledger = deployed(codes);
    ledger.instances.set(ledger.config!.stake, randomBytes(32).toString("hex"));
    const f = fake(ledger);
    expect(await refusal(ensurePhoenixTestnet(admin, f.deps, codes))).toBe("stake_other");
    expect(f.sent).toEqual([]);
  });

  test("code testnet lacks is read from mainnet by hash and uploaded only when its bytes hash to it", async () => {
    const wasm = randomBytes(64);
    const codes = { pool: sha256(wasm), stake: randomBytes(32).toString("hex") };
    const ledger = deployed(codes);
    ledger.codes.delete(codes.pool);
    const f = fake(ledger, new Map([[codes.pool, wasm]]));
    await ensurePhoenixTestnet(admin, f.deps, codes);
    expect(f.sent.map((s) => [s.kind, s.wasm])).toEqual([
      ["upload", codes.pool],
      ["extend", undefined],
    ]);

    const tampered = deployed(codes);
    tampered.codes.delete(codes.pool);
    const g = fake(tampered, new Map([[codes.pool, randomBytes(64)]]));
    expect(await refusal(ensurePhoenixTestnet(admin, g.deps, codes))).toBe("code_hash_mismatch");
    expect(g.sent).toEqual([]);

    const absent = deployed(codes);
    absent.codes.delete(codes.pool);
    const h = fake(absent);
    expect(await refusal(ensurePhoenixTestnet(admin, h.deps, codes))).toBe("code_not_on_mainnet");
    expect(h.sent).toEqual([]);
  });

  test("an empty pool is seeded once: the admin mints to a funded throwaway, which deposits", async () => {
    const codes = randomCodes();
    const f = fake(deployed(codes, { reserves: [BigInt(0), BigInt(0)] }));
    await ensurePhoenixTestnet(admin, f.deps, codes);
    expect(f.sent.map((s) => s.kind)).toEqual(["mint", "provide_liquidity", "extend"]);
    expect(f.sent[0]!.signer).toBe(admin.publicKey());
    expect(f.funded).toContain(f.sent[1]!.signer);
    expect(f.sent[1]!.signer).not.toBe(admin.publicKey());
  });
});
