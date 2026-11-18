import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import {
  contractIdFor,
  ensureToken,
  playgroundTokenDeployed,
  TOKEN_TTL_LEDGERS,
  TokenDeployError,
  type TokenConfig,
  type TokenDeployDeps,
} from "@/lib/token-deploy";

// The operator's token deployment (lib/token-deploy.ts) against a fake RPC, with a token of the
// test's own: a random admin, a random salt and the address they derive, so the whole run is
// exercised without the real admin's key.

/** The state archival settings testnet returned on 2026-11-18: a maximum entry TTL of 3,110,400. */
const ARCHIVAL = xdr.LedgerEntryData.fromXDR(
  "AAAACAAAAAoAL3YAAAAC0AAB2IAAAAAAAAAEvwAAAAAAAAl+AAAD6AAAAB4AAABAAAehIAAAAAc=",
  "base64"
);

const admin = Keypair.random();

function tokenOf(deployer: Keypair): TokenConfig {
  const salt = randomBytes(32).toString("hex");
  return {
    contract: contractIdFor(deployer.publicKey(), salt, Networks.TESTNET),
    admin: deployer.publicKey(),
    salt,
    wasmHash: randomBytes(32).toString("hex"),
    name: "Test Token",
    symbol: "TTKN",
    decimals: 7,
  };
}

interface Chain {
  /** The code the instance at the token's address runs, or null when there is none. */
  instance: string | null;
  codeLive: boolean;
  /** The admin `initialize` set, or null before it ran. */
  initializedBy: string | null;
  metadata: { decimals: number; name: string; symbol: string };
  /** What `createContract` simulates to, when it is not the token's own address. */
  createdAt?: string;
  minResourceFee?: string;
}

interface Fake {
  deps: Partial<TokenDeployDeps>;
  sent: { kind: string; signer: string; extendTo?: number }[];
  calls: number;
}

const contractDataEntry = (contract: string, wasmHash: string): xdr.LedgerEntryData =>
  xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHash, "hex")),
          storage: null,
        })
      ),
    })
  );

const codeEntry = (wasmHash: string): xdr.LedgerEntryData =>
  xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: Buffer.from(wasmHash, "hex"),
      code: Buffer.from([0]),
    })
  );

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

const addressAuth = (signer: string, contract: string, fn: string): xdr.SorobanAuthorizationEntry =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: BigInt(1),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: sourceAuth(contract, fn).rootInvocation,
  });

function success(
  chain: Chain,
  retval: xdr.ScVal | null,
  auth: xdr.SorobanAuthorizationEntry[] = []
): rpc.Api.RawSimulateTransactionResponse {
  const fee = chain.minResourceFee ?? "50000";
  return {
    id: "1",
    latestLedger: 100,
    transactionData: new SorobanDataBuilder().setResourceFee(fee).build().toXDR("base64"),
    minResourceFee: fee,
    ...(retval
      ? { results: [{ auth: auth.map((a) => a.toXDR("base64")), xdr: retval.toXDR("base64") }] }
      : {}),
    events: [],
  };
}

const failure = (): rpc.Api.RawSimulateTransactionResponse => ({
  id: "1",
  latestLedger: 100,
  error: "HostError: not initialized",
  events: [],
});

/** The operation a transaction holds, named for the fake's bookkeeping. */
function kindOf(tx: Transaction): string {
  const op = tx.operations[0];
  if (op?.type === "extendFootprintTtl") return "extend";
  if (op?.type !== "invokeHostFunction") return "other";
  if (op.func.type === "hostFunctionTypeInvokeContract") {
    return op.func.invokeContract.functionName.toString();
  }
  return "create";
}

/** A fake RPC over `chain`; every transaction sent lands unless `lands` is false. */
function fakeRpc(token: TokenConfig, chain: Chain, lands = true): Fake {
  const fake: Fake = { deps: {}, sent: [], calls: 0 };
  let last: Transaction | null = null;
  const server: TokenDeployDeps["rpc"] = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      fake.calls++;
      const entries = keys.flatMap((key) => {
        let val: xdr.LedgerEntryData | null = null;
        if (key.type === "configSetting") val = ARCHIVAL;
        else if (key.type === "contractCode" && chain.codeLive) val = codeEntry(token.wasmHash);
        else if (key.type === "contractData" && chain.instance) {
          val = contractDataEntry(token.contract, chain.instance);
        }
        return val ? [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 200 }] : [];
      });
      return { entries, latestLedger: 100 };
    },
    simulateTransaction: async (tx) => {
      fake.calls++;
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const kind = kindOf(tx);
      if (kind === "create") {
        const at = chain.createdAt ?? token.contract;
        return rpc.parseRawSimulation(success(chain, new Address(at).toScVal()));
      }
      if (kind === "extend") return rpc.parseRawSimulation(success(chain, null));
      if (kind === "initialize") {
        return rpc.parseRawSimulation(success(chain, xdr.ScVal.scvVoid()));
      }
      if (chain.initializedBy === null) return rpc.parseRawSimulation(failure());
      if (kind === "mint") {
        // Recording mode: the admin's authorization is the transaction's own exactly when the
        // admin sends it.
        const auth =
          chain.initializedBy === tx.source
            ? sourceAuth(token.contract, "mint")
            : addressAuth(chain.initializedBy, token.contract, "mint");
        return rpc.parseRawSimulation(success(chain, xdr.ScVal.scvVoid(), [auth]));
      }
      const value = chain.metadata[kind as keyof Chain["metadata"]];
      const type = kind === "decimals" ? "u32" : "string";
      return rpc.parseRawSimulation(success(chain, nativeToScVal(value, { type })));
    },
    sendTransaction: async (tx) => {
      fake.calls++;
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const kind = kindOf(tx);
      const op = tx.operations[0];
      fake.sent.push({
        kind,
        signer: tx.source,
        ...(op?.type === "extendFootprintTtl" ? { extendTo: op.extendTo } : {}),
      });
      if (kind === "create") chain.instance = token.wasmHash;
      if (kind === "initialize") chain.initializedBy = tx.source;
      expect(tx.signatures).toHaveLength(1);
      last = tx;
      return {
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 1,
        latestLedgerCloseTime: 0,
      };
    },
    getTransaction: async (hash) => {
      fake.calls++;
      const window = {
        txHash: hash,
        latestLedger: 2,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      };
      if (!lands || !last) return { ...window, status: rpc.Api.GetTransactionStatus.NOT_FOUND };
      return {
        ...window,
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1,
        createdAt: 0,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: last.toEnvelope(),
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
  fake.deps = { rpc: server, loadSequence: async () => "41", sleep: async () => {} };
  return fake;
}

const fresh = (token: TokenConfig, over: Partial<Chain> = {}): Chain => ({
  instance: null,
  codeLive: true,
  initializedBy: null,
  metadata: { decimals: token.decimals, name: token.name, symbol: token.symbol },
  ...over,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "deployed";
  } catch (err) {
    if (err instanceof TokenDeployError) return err.message;
    throw err;
  }
}

describe("ensureToken", () => {
  test("a first run creates the token, initializes it, proves the admin and extends it", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token));
    expect(await ensureToken(admin, token, fake.deps)).toBe(token.contract);
    expect(fake.sent).toEqual([
      { kind: "create", signer: admin.publicKey() },
      { kind: "initialize", signer: admin.publicKey() },
      { kind: "extend", signer: admin.publicKey(), extendTo: TOKEN_TTL_LEDGERS },
    ]);
  });

  test("a later run only checks the token and extends its TTL", async () => {
    const token = tokenOf(admin);
    const chain = fresh(token, { instance: token.wasmHash, initializedBy: admin.publicKey() });
    const fake = fakeRpc(token, chain);
    expect(await ensureToken(admin, token, fake.deps)).toBe(token.contract);
    expect(fake.sent.map((s) => s.kind)).toEqual(["extend"]);
  });

  test("a token created but never initialized is initialized before anything else", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token, { instance: token.wasmHash }));
    await ensureToken(admin, token, fake.deps);
    expect(fake.sent.map((s) => s.kind)).toEqual(["initialize", "extend"]);
  });

  test("an initialize someone else sent first, with another admin, fails the run", async () => {
    const token = tokenOf(admin);
    const squatter = Keypair.random().publicKey();
    const chain = fresh(token, { instance: token.wasmHash, initializedBy: squatter });
    const fake = fakeRpc(token, chain);
    expect(await refusal(ensureToken(admin, token, fake.deps))).toBe("admin_not_in_control");
    expect(fake.sent).toEqual([]);
  });

  test("a token initialized with other metadata fails the run", async () => {
    const token = tokenOf(admin);
    const chain = fresh(token, {
      instance: token.wasmHash,
      initializedBy: admin.publicKey(),
      metadata: { decimals: 6, name: token.name, symbol: token.symbol },
    });
    const fake = fakeRpc(token, chain);
    expect(await refusal(ensureToken(admin, token, fake.deps))).toBe("token_metadata_mismatch");
    expect(fake.sent).toEqual([]);
  });

  test("any key but the token's admin is refused before anything is read", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token));
    expect(await refusal(ensureToken(Keypair.random(), token, fake.deps))).toBe(
      "key_not_pinned_admin"
    );
    expect(fake.calls).toBe(0);
  });

  test("a pinned address its admin and salt do not derive is refused before anything is read", async () => {
    const token = { ...tokenOf(admin), contract: tokenOf(admin).contract };
    const fake = fakeRpc(token, fresh(token));
    expect(await refusal(ensureToken(admin, token, fake.deps))).toBe("contract_id_not_derived");
    expect(fake.calls).toBe(0);
  });

  test("an address running other code, or no token code on the ledger, sends nothing", async () => {
    const token = tokenOf(admin);
    const other = fakeRpc(token, fresh(token, { instance: randomBytes(32).toString("hex") }));
    expect(await refusal(ensureToken(admin, token, other.deps))).toBe("contract_runs_other_code");
    expect(other.sent).toEqual([]);
    const noCode = fakeRpc(token, fresh(token, { codeLive: false }));
    expect(await refusal(ensureToken(admin, token, noCode.deps))).toBe("token_code_not_on_ledger");
    expect(noCode.sent).toEqual([]);
  });

  test("a creation that would land anywhere but the pinned address is never signed", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token, { createdAt: tokenOf(admin).contract }));
    expect(await refusal(ensureToken(admin, token, fake.deps))).toBe("contract_id_mismatch");
    expect(fake.sent).toEqual([]);
  });

  test("a transaction whose fee is over the cap is never signed", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token, { minResourceFee: "200000000" }));
    expect(await refusal(ensureToken(admin, token, fake.deps))).toBe("fee_above_cap");
    expect(fake.sent).toEqual([]);
  });

  test("a transaction that never lands fails the run", async () => {
    const token = tokenOf(admin);
    const fake = fakeRpc(token, fresh(token), false);
    expect(await refusal(ensureToken(admin, token, fake.deps))).toStartWith("transaction_timeout");
    expect(fake.sent.map((s) => s.kind)).toEqual(["create"]);
  });
});

test("the token counts as deployed only while its address runs the pinned code", async () => {
  const token = tokenOf(admin);
  const read = (chain: Chain) => playgroundTokenDeployed(fakeRpc(token, chain).deps.rpc!, token);
  expect(await read(fresh(token, { instance: token.wasmHash }))).toBe(true);
  expect(await read(fresh(token))).toBe(false);
  expect(await read(fresh(token, { instance: randomBytes(32).toString("hex") }))).toBe(false);
});
