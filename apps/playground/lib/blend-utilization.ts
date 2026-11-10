import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { SOROBAN_RPC_TESTNET_URL } from "./horizon-submit";
import { BLEND } from "./scenarios";

// Whether the pinned Blend pool can lend the borrow variant its XLM. Blend refuses a borrow that
// would take a reserve's utilization over its cap, and on testnet the XLM reserve runs close to
// it, so the executor reads the reserve before anything is signed and refuses in plain language
// instead of failing on chain. Not server-only: the e2e suite reads the same reserve before it
// picks the borrow variant, so it can skip with the reason rather than fail.

/** The reserve's state as the pool reports it (`get_reserve`). */
export interface BlendReserveState {
  /** The utilization cap, 7 decimals (9_500_000 is 95%). */
  maxUtil: bigint;
  bSupply: bigint;
  dSupply: bigint;
  /** The supply and liability rates, 12 decimals on Blend V2. */
  bRate: bigint;
  dRate: bigint;
}

const RATE_SCALE = BigInt(10) ** BigInt(12);
const UTIL_SCALE = BigInt(10_000_000);

/** The pool's `get_reserve` answer, read for what the utilization needs and nothing else. */
export function blendReserveFrom(native: unknown): BlendReserveState {
  const reserve = native as {
    config?: { max_util?: unknown };
    data?: { b_supply?: unknown; d_supply?: unknown; b_rate?: unknown; d_rate?: unknown };
  };
  const int = (value: unknown): bigint => {
    if (typeof value === "bigint" && value >= BigInt(0)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return BigInt(value);
    }
    throw new Error("Blend reserve: unreadable state");
  };
  return {
    maxUtil: int(reserve.config?.max_util),
    bSupply: int(reserve.data?.b_supply),
    dSupply: int(reserve.data?.d_supply),
    bRate: int(reserve.data?.b_rate),
    dRate: int(reserve.data?.d_rate),
  };
}

/**
 * Whether a borrow of `borrowStroops` beside a supply of `supplyStroops` leaves the reserve's
 * utilization under its cap. The utilization counted is the one the pool would see once the demo's
 * own supply and borrow land, rounded toward refusing; at or over the cap is refused.
 */
export function blendBorrowFits(
  reserve: BlendReserveState,
  supplyStroops: bigint,
  borrowStroops: bigint
): boolean {
  // Liabilities round up and supply down, as the pool itself rounds them.
  const liabilities = (reserve.dSupply * reserve.dRate + RATE_SCALE - BigInt(1)) / RATE_SCALE;
  const supply = (reserve.bSupply * reserve.bRate) / RATE_SCALE;
  return (liabilities + borrowStroops) * UTIL_SCALE < reserve.maxUtil * (supply + supplyStroops);
}

/** Reads the pinned pool's XLM reserve on testnet by simulation; nothing is signed or sent. */
export async function readBlendReserve(
  server: Pick<rpc.Server, "simulateTransaction"> = new rpc.Server(SOROBAN_RPC_TESTNET_URL)
): Promise<BlendReserveState> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(BLEND.pool).call("get_reserve", new Address(BLEND.reserve).toScVal())
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Blend reserve: the read did not simulate");
  }
  return blendReserveFrom(scValToNative(sim.result.retval));
}
