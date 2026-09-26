import {
  Account,
  Address,
  Asset,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc as stellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { DefiPosition, FxdaoCdpPosition, PlanBlocker } from "@lumenwipe/types";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  EXIT_POSITION_GONE,
  type BuiltExitStep,
  type ExitAdapter,
  type ExitContext,
  type ExitPlan,
  type ExitRpc,
  type ExitStep,
} from "./adapter";
import { compareBaseUnits, isBaseUnits } from "./invariants";

/**
 * The FxDAO exit (architecture.md §9.7): a CDP vault locks XLM collateral and mints one of three
 * stablecoins (USDx/EURx/GBPx, one vault per denomination). Closing it means fully repaying the
 * stablecoin debt through `pay_debt`.
 *
 * Ground truth for this adapter came from three cross-checked sources, because the vault contract
 * this codebase's registry already tracks is not independently readable right now: the testnet
 * address (`contract-registry.json`) does not resolve on live testnet (`verifiedLive: false`), and
 * the documented mainnet address's currently deployed code exposes only `evict`/`upgrade` as entry
 * points (confirmed with `stellar contract info interface` against live mainnet RPC - not just
 * documentation). So this adapter is built from: (1) that same `stellar contract info interface`
 * dump, which - despite the reduced current entry points - still carries the full on-chain type
 * registry (`Vault`, `VaultKey`, `VaultsInfo`, `OptionalVaultKey`), (2) the official
 * `@fxdao/fxdao-sdk-js` npm package's source (not its `.d.ts`, which disagrees with the verified
 * on-chain `Vault` storage key shape - see below), and (3) fxdao.io's own docs. No dependency on
 * that npm package is taken: the encoding it needs is a handful of `ScVal` map/vec constructions,
 * hand-rolled here the same way `aquarius.ts`/`phoenix.ts` hand-roll their own protocols' encoding.
 *
 * Two findings shape the design:
 *
 * - **There is no on-chain "withdraw collateral" operation.** The official SDK's own vault-update
 *   helper implements exactly three operations - `increase_collateral`, `increase_debt`,
 *   `pay_debt` - and throws on anything else. When `pay_debt` brings `total_debt` to exactly zero,
 *   that same SDK computes the vault's new sort index as `0` and its new list position as `None`;
 *   FxDAO's own docs separately note that "vault deletion occurs automatically when debt reaches
 *   zero." Together with architecture.md's own phrasing (closing a vault "means repaying the
 *   stablecoin debt and withdrawing the XLM collateral", described as one action), the reading
 *   here is that a full `pay_debt` both clears the debt and returns the collateral atomically, in
 *   one call - not two. So a close plans exactly **one** step, kind `"repay"`, never a separate
 *   `withdraw_collateral` step.
 * - The vault contract tracks vaults in a denomination-scoped sorted linked list ordered by
 *   `index = (collateral * 1e9) / debt`; `pay_debt` needs the vault's current predecessor
 *   (`prev_key`) even though its new predecessor is always `None` for a full repay. Every vault
 *   entry carries its own `next_key`, and `VaultsInfo` (a direct, un-simulated ledger read, same
 *   as a single vault) carries the list's `lowest_key` - so `prev_key` is found by walking the
 *   chain via sequential direct ledger reads, never the simulated, paginated `get_vaults` crawl
 *   the official SDK uses for the same job.
 *
 * The one thing that cannot be read directly off the ledger is whether the vault is currently
 * undercollateralized (architecture.md §9.7: closing one that already is would invite liquidation,
 * so it must block for manual review rather than proceed). That comparison needs the live oracle
 * rate, which the contract's own `calculate_deposit_ratio(rate, collateral, debt)` turns into a
 * ratio in its own native units - compared as a raw integer against `min_col_rate` (also read
 * directly, from `VaultsInfo`), never converted to a percentage this adapter would have to guess
 * the decimal scale of. Both reads happen via simulation and are injectable (`FxdaoDeps`), because
 * the exact oracle call shape mirrors what the official SDK does, and could not be independently
 * verified against live bytecode for the reasons above; a wrong guess here fails closed (blocks),
 * never unsafely.
 */

export interface FxdaoVaultKeyLike {
  account: string;
  denomination: string;
  index: bigint;
}

export interface FxdaoVaultRecord {
  account: string;
  denomination: string;
  index: bigint;
  nextKey: FxdaoVaultKeyLike | null;
  totalCollateral: bigint;
  totalDebt: bigint;
}

export interface FxdaoVaultsInfo {
  lowestKey: FxdaoVaultKeyLike | null;
  minColRate: bigint;
  totalVaults: bigint;
}

export interface FxdaoCoreState {
  oracle: string;
  stableIssuer: string;
}

export type FxdaoLive =
  | {
      status: "loaded";
      vault: FxdaoVaultRecord;
      vaultsInfo: FxdaoVaultsInfo;
      prevKey: FxdaoVaultKeyLike | null;
      coreState: FxdaoCoreState;
      /** The vault's live collateral/debt ratio, in the contract's own native units - never
       *  rescaled to a percentage, so it stays comparable to `minColRate` without a decimal-scale
       *  assumption this adapter cannot verify. */
      ratio: bigint;
    }
  | { status: "not_vault"; kind: string }
  /** The account holds no open vault for this denomination - already closed, or never existed. */
  | { status: "not_found" }
  | { status: "unreadable" }
  | { status: "price_unreadable" };

export interface FxdaoDeps {
  getCurrentRatio(
    rpc: ExitRpc,
    ctx: ExitContext,
    vault: string,
    oracle: string,
    denomination: string,
    collateral: bigint,
    debt: bigint
  ): Promise<bigint | null>;
}

// ─── ScVal encoding/decoding ────────────────────────────────────────────────

const symbolVal = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const addressVal = (address: string): xdr.ScVal => new Address(address).toScVal();
const u128Val = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "u128" });
/** The general soroban_sdk enum-variant shape: a vec of the tag symbol plus its fields, verified
 *  here against `OptionalVaultKey`/`VaultsDataKeys` and this codebase's own `testnet-direct-read.ts`. */
const variantVal = (tag: string, ...fields: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvVec([symbolVal(tag), ...fields]);

/** `VaultKey{account, denomination, index}`, field order alphabetical - soroban_sdk's derive
 *  macro sorts struct fields this way, confirmed against the official SDK's own encoding. */
function vaultKeyVal(key: FxdaoVaultKeyLike): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbolVal("account"), val: addressVal(key.account) }),
    new xdr.ScMapEntry({ key: symbolVal("denomination"), val: symbolVal(key.denomination) }),
    new xdr.ScMapEntry({ key: symbolVal("index"), val: u128Val(key.index) }),
  ]);
}

function optionalVaultKeyVal(key: FxdaoVaultKeyLike | null): xdr.ScVal {
  return key === null ? variantVal("None") : variantVal("Some", vaultKeyVal(key));
}

const persistentKey = (contract: string, key: xdr.ScVal): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

const vaultsInfoLedgerKey = (vault: string, denomination: string): xdr.LedgerKey =>
  persistentKey(vault, variantVal("VaultsInfo", symbolVal(denomination)));

const vaultLedgerKey = (vault: string, account: string, denomination: string): xdr.LedgerKey =>
  persistentKey(
    vault,
    variantVal("Vault", xdr.ScVal.scvVec([addressVal(account), symbolVal(denomination)]))
  );

const coreStateLedgerKey = (vault: string): xdr.LedgerKey =>
  persistentKey(vault, variantVal("CoreState"));

function mapView(val: xdr.ScVal): Map<string, xdr.ScVal> {
  const out = new Map<string, xdr.ScVal>();
  if (val.switch() !== xdr.ScValType.scvMap()) return out;
  for (const entry of val.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol()) out.set(key.sym().toString(), entry.val());
  }
  return out;
}

const asAddress = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvAddress()
    ? Address.fromScAddress(val.address()).toString()
    : null;

const asSymbol = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvSymbol() ? val.sym().toString() : null;

const asUnsigned = (val: xdr.ScVal | undefined): bigint | null => {
  if (!val) return null;
  const native: unknown = scValToNative(val);
  if (typeof native === "bigint") return native >= 0n ? native : null;
  if (typeof native === "number" && Number.isInteger(native) && native >= 0) return BigInt(native);
  return null;
};

/** `null` for a genuine `OptionalVaultKey::None`; `undefined` for anything malformed. */
function decodeOptionalVaultKey(val: xdr.ScVal | undefined): FxdaoVaultKeyLike | null | undefined {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return undefined;
  const vec = val.vec() ?? [];
  const tag = asSymbol(vec[0]);
  if (tag === "None") return null;
  if (tag !== "Some" || !vec[1]) return undefined;
  const fields = mapView(vec[1]);
  const account = asAddress(fields.get("account"));
  const denomination = asSymbol(fields.get("denomination"));
  const index = asUnsigned(fields.get("index"));
  if (account === null || denomination === null || index === null) return undefined;
  return { account, denomination, index };
}

function decodeVault(val: xdr.LedgerEntryData): FxdaoVaultRecord | null {
  const fields = mapView(val.contractData().val());
  const account = asAddress(fields.get("account"));
  const denomination = asSymbol(fields.get("denomination"));
  const index = asUnsigned(fields.get("index"));
  const nextKey = decodeOptionalVaultKey(fields.get("next_key"));
  const totalCollateral = asUnsigned(fields.get("total_collateral"));
  const totalDebt = asUnsigned(fields.get("total_debt"));
  if (
    account === null ||
    denomination === null ||
    index === null ||
    nextKey === undefined ||
    totalCollateral === null ||
    totalDebt === null
  ) {
    return null;
  }
  return { account, denomination, index, nextKey, totalCollateral, totalDebt };
}

function decodeVaultsInfo(val: xdr.LedgerEntryData): FxdaoVaultsInfo | null {
  const fields = mapView(val.contractData().val());
  const lowestKey = decodeOptionalVaultKey(fields.get("lowest_key"));
  const minColRate = asUnsigned(fields.get("min_col_rate"));
  const totalVaults = asUnsigned(fields.get("total_vaults"));
  if (lowestKey === undefined || minColRate === null || totalVaults === null) return null;
  return { lowestKey, minColRate, totalVaults };
}

function decodeCoreState(val: xdr.LedgerEntryData): FxdaoCoreState | null {
  const fields = mapView(val.contractData().val());
  const oracle = asAddress(fields.get("oracle"));
  const stableIssuer = asAddress(fields.get("stable_issuer"));
  if (oracle === null || stableIssuer === null) return null;
  return { oracle, stableIssuer };
}

async function readEntries(
  rpc: ExitRpc,
  keys: xdr.LedgerKey[]
): Promise<Map<string, xdr.LedgerEntryData>> {
  const res = await rpc.getLedgerEntries(...keys);
  const out = new Map<string, xdr.LedgerEntryData>();
  for (const entry of res.entries ?? []) out.set(entry.key.toXDR("base64"), entry.val);
  return out;
}

/**
 * The vault's current predecessor in the sorted list, walked one hop at a time via direct ledger
 * reads (each hop depends on the previous one's `next_key`, so this cannot be batched). `null`
 * for "our vault is the lowest"; `undefined` when the chain does not lead to our vault within
 * `maxHops` - a corrupt or inconsistent list, treated as unreadable rather than looped on forever.
 */
async function findPrevKey(
  rpc: ExitRpc,
  vault: string,
  denomination: string,
  account: string,
  lowestKey: FxdaoVaultKeyLike | null,
  maxHops: number
): Promise<FxdaoVaultKeyLike | null | undefined> {
  if (lowestKey === null) return undefined;
  if (lowestKey.account === account) return null;
  let cursor = lowestKey;
  for (let hop = 0; hop < maxHops; hop++) {
    const key = vaultLedgerKey(vault, cursor.account, denomination);
    const entries = await readEntries(rpc, [key]);
    const val = entries.get(key.toXDR("base64"));
    if (!val) return undefined;
    const decoded = decodeVault(val);
    if (!decoded) return undefined;
    if (decoded.nextKey?.account === account) {
      return { account: decoded.account, denomination: decoded.denomination, index: decoded.index };
    }
    if (!decoded.nextKey) return undefined;
    cursor = decoded.nextKey;
  }
  return undefined;
}

/** A read-only contract call, evaluated by simulation and never signed. */
async function simulateReadonly(
  rpc: ExitRpc,
  ctx: ExitContext,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal | null> {
  const tx = new TransactionBuilder(new Account(ctx.account, ctx.sequence), {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[ctx.network],
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const response = await rpc.simulateTransaction(tx);
  const simulation = stellarRpc.Api.isSimulationRaw(response)
    ? stellarRpc.parseRawSimulation(response)
    : response;
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) return null;
  return simulation.result?.retval ?? null;
}

/** SEP-40-shaped `PriceData{price, timestamp}`; `void` (soroban_sdk's `Option::None`) has no rate. */
function priceFromLastprice(val: xdr.ScVal): bigint | null {
  if (val.switch() === xdr.ScValType.scvVoid()) return null;
  return asUnsigned(mapView(val).get("price"));
}

export const defaultFxdaoDeps: FxdaoDeps = {
  async getCurrentRatio(rpc, ctx, vault, oracle, denomination, collateral, debt) {
    const priceVal = await simulateReadonly(
      rpc,
      ctx,
      oracle,
      "lastprice",
      addressVal(vault),
      variantVal("Other", symbolVal(denomination))
    );
    if (!priceVal) return null;
    const price = priceFromLastprice(priceVal);
    if (price === null) return null;
    const ratioVal = await simulateReadonly(
      rpc,
      ctx,
      vault,
      "calculate_deposit_ratio",
      u128Val(price),
      u128Val(collateral),
      u128Val(debt)
    );
    return ratioVal ? asUnsigned(ratioVal) : null;
  },
};

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function manualReview(code: string, message: string): ExitPlan {
  const blocker: PlanBlocker = { code, message };
  return { steps: [], blockers: [blocker] };
}

export function fxdaoExitAdapter(
  deps: FxdaoDeps = defaultFxdaoDeps
): ExitAdapter<FxdaoCdpPosition, FxdaoLive> {
  return {
    protocol: "fxdao",

    supports(position: DefiPosition): position is FxdaoCdpPosition {
      return position.protocol === "fxdao" && position.positionType === "cdp";
    },

    async readLive(position, code, ctx, rpc): Promise<FxdaoLive> {
      if (code.kind !== "vault") return { status: "not_vault", kind: code.kind };

      try {
        const vault = position.contractAddress;
        const denomination = position.denomination;
        const infoKey = vaultsInfoLedgerKey(vault, denomination);
        const ownKey = vaultLedgerKey(vault, ctx.account, denomination);
        const coreKey = coreStateLedgerKey(vault);
        const first = await readEntries(rpc, [infoKey, ownKey, coreKey]);

        const infoVal = first.get(infoKey.toXDR("base64"));
        const coreVal = first.get(coreKey.toXDR("base64"));
        if (!infoVal || !coreVal) return { status: "unreadable" };
        const vaultsInfo = decodeVaultsInfo(infoVal);
        const coreState = decodeCoreState(coreVal);
        if (!vaultsInfo || !coreState) return { status: "unreadable" };

        const ownVal = first.get(ownKey.toXDR("base64"));
        if (!ownVal) return { status: "not_found" };
        const record = decodeVault(ownVal);
        if (!record || record.account !== ctx.account) return { status: "unreadable" };
        if (record.totalDebt === 0n) return { status: "not_found" };

        const maxHops = Math.min(Number(vaultsInfo.totalVaults) + 1, 10_000);
        const prevKey = await findPrevKey(
          rpc,
          vault,
          denomination,
          ctx.account,
          vaultsInfo.lowestKey,
          maxHops
        );
        if (prevKey === undefined) return { status: "unreadable" };

        const ratio = await deps.getCurrentRatio(
          rpc,
          ctx,
          vault,
          coreState.oracle,
          denomination,
          record.totalCollateral,
          record.totalDebt
        );
        if (ratio === null) return { status: "price_unreadable" };

        return { status: "loaded", vault: record, vaultsInfo, prevKey, coreState, ratio };
      } catch {
        return { status: "unreadable" };
      }
    },

    plan(position, live, _code, ctx): ExitPlan {
      const vaultLabel = shortAddress(position.contractAddress);
      if (live.status === "not_vault") {
        return manualReview(
          "fxdao_contract_not_vault",
          `The FxDAO contract ${vaultLabel} holding this position is registered as a ${live.kind}, ` +
            "not a vault. No exit was built; this position needs manual review."
        );
      }
      if (live.status === "not_found") {
        return manualReview(
          EXIT_POSITION_GONE,
          `This account no longer holds an open FxDAO vault at ${vaultLabel} for this denomination; ` +
            "the position was already closed."
        );
      }
      if (live.status === "unreadable") {
        return manualReview(
          "fxdao_vault_unreadable",
          `The FxDAO vault ${vaultLabel} could not be read as a vault right now - its data, its ` +
            "position in the sorted list, or the protocol's core state may be unavailable. No exit " +
            "was built; retry the analysis, and if it keeps failing this position needs manual review."
        );
      }
      if (live.status === "price_unreadable") {
        return manualReview(
          "fxdao_price_unreadable",
          `The current exchange rate for FxDAO vault ${vaultLabel}'s denomination could not be read ` +
            "from the oracle right now, so its collateral ratio cannot be confirmed safe to close. " +
            "No exit was built; retry the analysis."
        );
      }

      const { vault, vaultsInfo } = live;
      if (live.ratio < vaultsInfo.minColRate) {
        return manualReview(
          "fxdao_vault_undercollateralized",
          `FxDAO vault ${vaultLabel} is currently below the protocol's minimum collateral ratio. ` +
            "Closing an already-undercollateralized vault risks it being liquidated before the close " +
            "completes, so no exit was built. Manage this vault directly through FxDAO first, or " +
            "wait for its ratio to recover, then retry."
        );
      }

      const passphrase = NETWORK_PASSPHRASES[ctx.network];
      const stableAsset = new Asset(vault.denomination, live.coreState.stableIssuer).contractId(
        passphrase
      );
      const debt = vault.totalDebt.toString();
      const holding = ctx.tokenBalances[stableAsset];
      if (!isBaseUnits(holding)) {
        return manualReview(
          "fxdao_repay_asset_balance_unknown",
          `Repaying FxDAO vault ${vaultLabel}'s debt spends ${vault.denomination}, and LumenWipe ` +
            "could not determine how much of it the account holds. No exit was built; this position " +
            "needs manual review."
        );
      }
      if (compareBaseUnits(holding, debt) < 0) {
        const shortfall = (vault.totalDebt - BigInt(holding)).toString();
        return manualReview(
          "fxdao_repay_asset_missing",
          `Repaying FxDAO vault ${vaultLabel}'s debt in full needs ${debt} base units of ` +
            `${vault.denomination} and the account holds ${holding} - ${shortfall} short. Acquire ` +
            "the asset first; a partial repay would leave the vault in an inconsistent state."
        );
      }

      const step: ExitStep = {
        kind: "repay",
        contract: position.contractAddress,
        function: "pay_debt",
        asset: stableAsset,
        amount: debt,
        ceiling: holding,
        minReceived: [],
        description:
          `Repay the full ${debt} base units of ${vault.denomination} debt in FxDAO vault ` +
          `${vaultLabel}, which also returns its ${vault.totalCollateral} base units of XLM collateral`,
      };
      return { steps: [step], blockers: [] };
    },

    // A full `pay_debt` always clears every unit of debt this adapter plans against (`plan()`
    // above blocks the whole position first if the account cannot cover it in full - never a
    // partial repay), so the state a plan leaves the position in before any withdrawal always has
    // zero debt: there is nothing for the shared post-repay HealthInputs check to usefully assess.
    // The undercollateralization gate that matters here - is the vault safe to close AT ALL - runs
    // pre-repay in `plan()` above, directly against the vault's own native-unit ratio rather than
    // a manufactured decimal percentage this adapter has no way to verify the scale of against
    // live bytecode (see the module doc comment). Returning null here is the same choice
    // `aquarius.ts`/`phoenix.ts` make for a position with no debt concept at all.
    health(): null {
      return null;
    },

    buildStep(step, live, ctx): BuiltExitStep {
      if (live.status !== "loaded") throw new Error("FxDAO: cannot build against an unread vault");
      const { vault, prevKey } = live;
      const vaultKey: FxdaoVaultKeyLike = {
        account: vault.account,
        denomination: vault.denomination,
        index: vault.index,
      };
      const op = new Contract(step.contract).call(
        "pay_debt",
        optionalVaultKeyVal(prevKey),
        vaultKeyVal(vaultKey),
        // A full repay always zeroes the vault's sort index, so its new predecessor is always
        // `None` - matching the official SDK's own handling of a debt-to-zero update.
        optionalVaultKeyVal(null),
        u128Val(BigInt(step.amount))
      );
      return {
        step,
        build: { source: "local", op },
        intent: {
          contract: step.contract,
          function: "pay_debt",
          args: [vault.account, vault.denomination, step.amount],
          minReceived: [],
          recipient: ctx.account,
        },
      };
    },
  };
}
