import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Networks,
  rpc,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { SEP45_REFERENCE_WASM_HASH } from "@/integrator/contract-auth";
import { v1TransactionFromXdr } from "../support/v1-transaction";
import { TTL_LEDGERS, type PhoenixTestnetDeps } from "../../scripts/phoenix-testnet-pool";
import { CONTRACT_ENV, main } from "../../scripts/web-auth-testnet-ttl";

// The nightly TTL extension of the testnet web authentication contract against a fake ledger.
// Every key is generated per run and the contract address is random.

/** The state archival settings testnet returned on 2026-11-18: a maximum entry TTL of 3,110,400. */
const ARCHIVAL = xdr.LedgerEntryData.fromXDR(
  "AAAACAAAAAoAL3YAAAAC0AAB2IAAAAAAAAAEvwAAAAAAAAl+AAAD6AAAAB4AAABAAAehIAAAAAc=",
  "base64"
);

const CONTRACT = StrKey.encodeContract(randomBytes(32));

const wasm = (hash: string): xdr.ContractExecutable =>
  xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex"));

interface Ledger {
  passphrase: string;
  /** What the contract's instance runs, or undefined when it holds no instance. */
  executable: xdr.ContractExecutable | undefined;
  codeLive: boolean;
}

const healthy = (over: Partial<Ledger> = {}): Ledger => ({
  passphrase: Networks.TESTNET,
  executable: wasm(SEP45_REFERENCE_WASM_HASH),
  codeLive: true,
  ...over,
});

interface Extension {
  signer: string;
  extendTo: number;
  footprint: string[];
}

function fake(ledger: Ledger) {
  const calls: string[] = [];
  const funded: string[] = [];
  const sent: Extension[] = [];
  let last: Transaction | null = null;
  const entryFor = (key: xdr.LedgerKey): xdr.LedgerEntryData | null => {
    if (key.type === "configSetting") return ARCHIVAL;
    if (key.type === "contractCode") {
      const hash = Buffer.from(key.contractCode.hash.toBytes()).toString("hex");
      return ledger.codeLive && hash === SEP45_REFERENCE_WASM_HASH
        ? xdr.LedgerEntryData.contractCode(
            new xdr.ContractCodeEntry({
              ext: xdr.ContractCodeEntryExt.v0(),
              hash: Buffer.from(hash, "hex"),
              code: Buffer.from([0]),
            })
          )
        : null;
    }
    if (key.type !== "contractData" || !ledger.executable) return null;
    if (Address.fromScAddress(key.contractData.contract).toString() !== CONTRACT) return null;
    return xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: key.contractData.contract,
        key: key.contractData.key,
        durability: xdr.ContractDataDurability.persistent,
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable: ledger.executable, storage: null })
        ),
      })
    );
  };
  const readOnly = (tx: Transaction): xdr.LedgerKey[] => {
    const v1 = v1TransactionFromXdr(tx.toXDR());
    if (v1.ext.type !== "sorobanData") throw new Error("no soroban data");
    return v1.ext.sorobanData.resources.footprint.readOnly;
  };
  const server: PhoenixTestnetDeps["rpc"] = {
    getNetwork: async () => {
      calls.push("getNetwork");
      return { passphrase: ledger.passphrase, protocolVersion: "23" };
    },
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push("getLedgerEntries");
      const entries = keys.flatMap((key) => {
        const val = entryFor(key);
        return val ? [{ key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 200 }] : [];
      });
      return { entries, latestLedger: 100 };
    },
    simulateTransaction: async (tx) => {
      calls.push("simulateTransaction");
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const v1 = v1TransactionFromXdr(tx.toXDR());
      if (v1.ext.type !== "sorobanData") throw new Error("no soroban data");
      return rpc.parseRawSimulation({
        id: "1",
        latestLedger: 100,
        transactionData: new SorobanDataBuilder(v1.ext.sorobanData)
          .setResourceFee("50000")
          .build()
          .toXDR("base64"),
        minResourceFee: "50000",
        events: [],
      });
    },
    sendTransaction: async (tx) => {
      calls.push("sendTransaction");
      if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
      const op = tx.operations[0];
      if (op?.type !== "extendFootprintTtl") throw new Error(`unexpected ${op?.type}`);
      sent.push({
        signer: tx.source,
        extendTo: op.extendTo,
        footprint: readOnly(tx).map((k) => k.toXDR("base64")),
      });
      last = tx;
      return {
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 1,
        latestLedgerCloseTime: 0,
      };
    },
    getTransaction: async (hash) => ({
      txHash: hash,
      latestLedger: 2,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
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
    }),
  };
  const deps: PhoenixTestnetDeps = {
    rpc: server,
    mainnetRpc: {
      getLedgerEntries: async () => {
        throw new Error("mainnet was read");
      },
    },
    loadSequence: async () => "41",
    fund: async (address) => {
      funded.push(address);
    },
    newKeypair: () => Keypair.random(),
    sleep: async () => {},
    log: () => {},
  };
  return { deps, calls, funded, sent };
}

/** Runs `main` with the contract variable alone and returns what it wrote to stderr. */
async function run(
  f: ReturnType<typeof fake>,
  env: Record<string, string | undefined> = { [CONTRACT_ENV]: CONTRACT },
  deps: () => PhoenixTestnetDeps = () => f.deps
): Promise<{ code: number; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(env, deps), stderr };
  } finally {
    process.stderr.write = write;
  }
}

const instanceKeyXdr = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(CONTRACT).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  })
).toXDR("base64");

const codeKeyXdr = xdr.LedgerKey.contractCode(
  new xdr.LedgerKeyContractCode({ hash: Buffer.from(SEP45_REFERENCE_WASM_HASH, "hex") })
).toXDR("base64");

/** Nothing was funded, simulated or sent. */
function expectNothingWritten(f: ReturnType<typeof fake>): void {
  expect(f.funded).toEqual([]);
  expect(f.sent).toEqual([]);
  expect(f.calls).not.toContain("simulateTransaction");
  expect(f.calls).not.toContain("sendTransaction");
}

describe("the web authentication contract's TTL extension", () => {
  test("extends exactly the instance and the reference code from a funded throwaway", async () => {
    const f = fake(healthy());
    expect((await run(f)).code).toBe(0);
    expect(f.calls.slice(0, 2)).toEqual(["getNetwork", "getLedgerEntries"]);
    expect(f.sent).toHaveLength(1);
    const [extension] = f.sent;
    expect(extension!.extendTo).toBe(TTL_LEDGERS);
    expect(extension!.footprint.sort()).toEqual([instanceKeyXdr, codeKeyXdr].sort());
    expect(f.funded).toEqual([extension!.signer]);
  });

  test("refuses any network but testnet before reading or writing anything", async () => {
    const f = fake(healthy({ passphrase: Networks.PUBLIC }));
    const { code, stderr } = await run(f);
    expect(code).toBe(1);
    expect(stderr).toContain("not_testnet");
    expect(f.calls).toEqual(["getNetwork"]);
    expectNothingWritten(f);
  });

  test("an instance running other code, an external reference or an asset is refused", async () => {
    const externalRef = xdr.ContractExecutable.contractExecutableExternalRef(
      new xdr.ContractExecutableExternalRef({
        executableOwner: new Address(StrKey.encodeContract(randomBytes(32))).toScAddress(),
        tag: "sep45",
      })
    );
    for (const executable of [
      wasm(randomBytes(32).toString("hex")),
      externalRef,
      xdr.ContractExecutable.contractExecutableStellarAsset(),
    ]) {
      const f = fake(healthy({ executable }));
      const { code, stderr } = await run(f);
      expect(code).toBe(1);
      expect(stderr).toContain("web_auth_other");
      expectNothingWritten(f);
    }
  });

  test("a missing instance or a missing code is refused", async () => {
    for (const [ledger, reason] of [
      [healthy({ executable: undefined }), "web_auth_missing"],
      [healthy({ codeLive: false }), "code_missing"],
    ] as const) {
      const f = fake(ledger);
      const { code, stderr } = await run(f);
      expect(code).toBe(1);
      expect(stderr).toContain(reason);
      expectNothingWritten(f);
    }
  });

  test("a missing, blank or non-contract variable is refused before any RPC call", async () => {
    for (const value of [undefined, "", "  ", Keypair.random().publicKey(), "CNOTANADDRESS"]) {
      const f = fake(healthy());
      const { code, stderr } = await run(f, { [CONTRACT_ENV]: value }, () => {
        throw new Error("dependencies were built");
      });
      expect(code).toBe(1);
      expect(stderr).toBe(
        `Refused: ${CONTRACT_ENV} must hold the testnet web authentication contract (C...).\n`
      );
      expect(f.calls).toEqual([]);
    }
  });
});
