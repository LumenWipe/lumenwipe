/**
 * Test-only setup for `fxdao-exit-adapter.integration.test.ts`: opens a real vault on the
 * project's own reference FxDAO deployment (see contract-registry.json's fxdao/vault entry) so
 * the test can exit a fixture it generated itself, never a pre-seeded account. Feeds the
 * project's own oracle a fresh price first - the oracle is a simple admin-writable price-record
 * contract (`set_records`), not a live third-party feed, so nothing else keeps it fresh.
 *
 * Deliberately hand-rolls the same ScVal encoding `src/lib/defi-exits/fxdao.ts` does, rather than
 * importing from it: this file builds the position the adapter under test will read, and sharing
 * encoding helpers with the adapter would let a bug in one silently agree with a bug in the other.
 */
import {
  Account,
  Address,
  Contract,
  Horizon,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as stellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";

export const FXDAO_VAULT = "CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N";
export const FXDAO_ORACLE = "CBWWY2QDQ2UVCUBR2SHWML7R5MN7I6WA5TDJCOPHKLE3RHQO2OSFOUDJ";
/** The `usd` currency's registered debt-token contract (a fresh admin-mintable SEP-41 token, not
 *  a classic-asset SAC - see the bug fix in `src/lib/defi-exits/fxdao.ts` this deployment exposed:
 *  the real `Currency.contract` was never derivable from `Asset(denomination, stable_issuer)`). */
export const FXDAO_CURRENCY_CONTRACT = "CAEGVALLV7CA2SIFEDJNA52RKGUWRQWQXM5YNFUH7TH5G6X6QXMRQM4L";
export const FXDAO_DENOMINATION = "usd";
/** Opening ratio comfortably above the fixed 115% `opening_col_rate` regardless of the oracle
 *  price fed - 200 XLM collateral for 10 usd debt at the 1:1 price this setup always feeds. */
export const FXDAO_COLLATERAL_STROOPS = 200_000_000n;
export const FXDAO_DEBT_UNITS = 100_000_000n;

const BASE_FEE = "1000000";
const TX_TIMEOUT_SECONDS = 60;
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const symbolVal = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const addressVal = (address: string): xdr.ScVal => new Address(address).toScVal();
const u128Val = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "u128" });
const variantVal = (tag: string, ...fields: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvVec([symbolVal(tag), ...fields]);

export interface VaultKeyLike {
  account: string;
  denomination: string;
  index: bigint;
}

function vaultKeyVal(key: VaultKeyLike): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbolVal("account"), val: addressVal(key.account) }),
    new xdr.ScMapEntry({ key: symbolVal("denomination"), val: symbolVal(key.denomination) }),
    new xdr.ScMapEntry({ key: symbolVal("index"), val: u128Val(key.index) }),
  ]);
}

const optionalVaultKeyVal = (key: VaultKeyLike | null): xdr.ScVal =>
  key === null ? variantVal("None") : variantVal("Some", vaultKeyVal(key));

// One Soroban invoke-host-function operation per transaction - simulation itself refuses more
// than one, so a caller with two calls to make (see feedFxdaoOraclePrice) must submit them as two
// separate transactions, not batch them.
async function buildSignSubmit(source: Keypair, op: xdr.Operation): Promise<void> {
  const rpc = getRpcServer("testnet");
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const simulation = await rpc.simulateTransaction(tx);
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`fxdao setup simulation failed: ${JSON.stringify(simulation)}`);
  }
  const assembled = stellarRpc.assembleTransaction(tx, simulation).build();
  assembled.sign(source);
  await submitAndWait(assembled.toXDR(), "testnet");
}

/**
 * Re-grants the vault's oracle read quota, then feeds a fresh price. Both have to happen every
 * run, not just once at bootstrap: the oracle's per-caller `CustomerQuota` entry is not permanent
 * storage - it expired a few hours after the initial manual grant, which briefly made every
 * `new_vault` call fail with `NotEnoughQuota` even though the price record itself was still
 * fresh. 1 usd = 1 XLM (both 7-decimal base units), matching how the reference oracle was first
 * seeded.
 */
export async function feedFxdaoOraclePrice(oracleAdmin: Keypair): Promise<void> {
  const quotaOp = new Contract(FXDAO_ORACLE).call(
    "set_quota",
    addressVal(FXDAO_VAULT),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: symbolVal("current"),
        val: nativeToScVal(0n, { type: "u64" }),
      }),
      new xdr.ScMapEntry({
        // A generous, far-future expiry rather than a permanent grant - re-set every run anyway,
        // so an expired quota never blocks a test that's otherwise passing everything else.
        key: symbolVal("exp"),
        val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60), {
          type: "u64",
        }),
      }),
      new xdr.ScMapEntry({
        key: symbolVal("max"),
        val: nativeToScVal(1_000_000n, { type: "u64" }),
      }),
    ])
  );
  const priceOp = new Contract(FXDAO_ORACLE).call(
    "set_records",
    xdr.ScVal.scvVec([variantVal("Other", symbolVal(FXDAO_DENOMINATION))]),
    xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        // PriceData.price is i128, unlike everything else here (u128) - a u128 encoding traps
        // the contract on deserialization (confirmed the hard way, see the bug this call caught).
        new xdr.ScMapEntry({
          key: symbolVal("price"),
          val: nativeToScVal(10_000_000n, { type: "i128" }),
        }),
        new xdr.ScMapEntry({
          key: symbolVal("timestamp"),
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: "u64" }),
        }),
      ]),
    ])
  );
  await buildSignSubmit(oracleAdmin, quotaOp);
  await buildSignSubmit(oracleAdmin, priceOp);
}

/** `VaultsDataKeys::Vault` persistent entry, keyed the same way `fxdao.ts` reads it. */
function vaultLedgerKey(account: string, denomination: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(FXDAO_VAULT).toScAddress(),
      key: variantVal("Vault", xdr.ScVal.scvVec([addressVal(account), symbolVal(denomination)])),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

function mapView(val: xdr.ScVal): Map<string, xdr.ScVal> {
  const out = new Map<string, xdr.ScVal>();
  if (val.switch() !== xdr.ScValType.scvMap()) return out;
  for (const entry of val.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol()) out.set(key.sym().toString(), entry.val());
  }
  return out;
}

function decodeOptionalKey(val: xdr.ScVal | undefined): VaultKeyLike | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const vec = val.vec() ?? [];
  if (vec[0]?.sym().toString() !== "Some" || !vec[1]) return null;
  const fields = mapView(vec[1]);
  return {
    account: Address.fromScAddress(fields.get("account")!.address()).toString(),
    denomination: fields.get("denomination")!.sym().toString(),
    index: BigInt(scValToNative(fields.get("index")!) as bigint),
  };
}

/**
 * Walks the sorted vault list to its tail (bounded: this deployment only ever serves these two
 * integration tests, so a handful of hops covers any realistic leftover state). Returns the last
 * vault's key as the insertion point for a new, deliberately over-collateralized vault - which
 * always sorts at or near the top of the list - or `null` when the list is empty.
 */
export async function findFxdaoInsertionPrevKey(): Promise<VaultKeyLike | null> {
  const rpc = getRpcServer("testnet");
  const instanceKey = new Contract(FXDAO_VAULT).getFootprint();
  const instanceRes = await rpc.getLedgerEntries(instanceKey);
  const instanceVal = instanceRes.entries?.[0]?.val;
  if (!instanceVal) throw new Error("fxdao vault instance entry not found");
  const storage = instanceVal.contractData().val().instance().storage() ?? [];
  let vaultsInfoVal: xdr.ScVal | undefined;
  for (const entry of storage) {
    try {
      const native = scValToNative(entry.key());
      if (Array.isArray(native) && native[0] === "VaultsInfo" && native[1] === FXDAO_DENOMINATION) {
        vaultsInfoVal = entry.val();
      }
    } catch {
      continue;
    }
  }
  let cursor = vaultsInfoVal ? decodeOptionalKey(mapView(vaultsInfoVal).get("lowest_key")) : null;
  if (!cursor) return null;

  for (let hop = 0; hop < 20; hop++) {
    const key = vaultLedgerKey(cursor.account, cursor.denomination);
    const res = await rpc.getLedgerEntries(key);
    const val = res.entries?.[0]?.val;
    if (!val) throw new Error(`fxdao vault entry for ${cursor.account} not found mid-chain`);
    const fields = mapView(val.contractData().val());
    const next = decodeOptionalKey(fields.get("next_key"));
    if (!next) return cursor;
    cursor = next;
  }
  throw new Error("fxdao vault chain did not terminate within 20 hops");
}

/** Opens a fresh vault for `account`, comfortably over-collateralized at the reference
 *  deployment's fixed conditions (110% min, 115% opening, 10 usd minimum debt). */
export async function openFxdaoVault(account: Keypair): Promise<void> {
  const prevKey = await findFxdaoInsertionPrevKey();
  const op = new Contract(FXDAO_VAULT).call(
    "new_vault",
    optionalVaultKeyVal(prevKey),
    addressVal(account.publicKey()),
    u128Val(FXDAO_DEBT_UNITS),
    u128Val(FXDAO_COLLATERAL_STROOPS),
    symbolVal(FXDAO_DENOMINATION)
  );
  await buildSignSubmit(account, op);
}
