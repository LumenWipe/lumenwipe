import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { SOROBAN_RPC_TESTNET_URL } from "./horizon-submit";
import { PHOENIX, PHOENIX_SEED } from "./scenarios";

// The pinned Phoenix pool as the scenario's executors see it: what a swap would return, the pool's
// reserves and a token balance, each read by simulation before anything is signed, and the amounts
// the seeding calls are sized from. Not server-only: the e2e suite reads the same swap quote
// before it runs the scenario, so it can skip with the reason rather than fail.

/** What `simulate_swap` says a swap would return, in LWPHX base units. */
export interface PhoenixSwapQuote {
  /** What the demo would receive, after the pool's commission. */
  askAmount: bigint;
  /** What the pool's price moves against the swap. */
  spreadAmount: bigint;
}

/** The pool's reserves (`query_pool_info`), token_a (LWPHX) and token_b (XLM). */
export interface PhoenixReserves {
  reserveA: bigint;
  reserveB: bigint;
}

/** The reads the Phoenix executors make; each one simulates, and nothing is signed or sent. */
export interface PhoenixReads {
  swapQuote: (offerStroops: bigint) => Promise<PhoenixSwapQuote>;
  reserves: () => Promise<PhoenixReserves>;
  /** A SEP-41 `balance(id)`, in the token's base units. */
  balance: (token: string, account: string) => Promise<bigint>;
}

const BPS = BigInt(10_000);

const int = (value: unknown, what: string): bigint => {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`Phoenix pool: unreadable ${what}`);
};

/** The pool's `simulate_swap` answer, read for what the gate needs and nothing else. */
export function phoenixSwapQuoteFrom(native: unknown): PhoenixSwapQuote {
  const quote = native as { ask_amount?: unknown; spread_amount?: unknown } | null;
  return {
    askAmount: int(quote?.ask_amount, "swap quote"),
    spreadAmount: int(quote?.spread_amount, "swap quote"),
  };
}

/** The pool's `query_pool_info` answer: its two reserves, each checked to be the pinned token. */
export function phoenixReservesFrom(native: unknown): PhoenixReserves {
  const info = native as {
    asset_a?: { address?: unknown; amount?: unknown };
    asset_b?: { address?: unknown; amount?: unknown };
  } | null;
  if (info?.asset_a?.address !== PHOENIX.tokenA || info.asset_b?.address !== PHOENIX.tokenB) {
    throw new Error("Phoenix pool: its tokens are not the pinned ones");
  }
  return {
    reserveA: int(info.asset_a.amount, "reserve"),
    reserveB: int(info.asset_b.amount, "reserve"),
  };
}

/**
 * Whether the quoted swap is one the scenario may sign: it returns at least the least LWPHX the
 * scenario uses, and the spread is at most `PHOENIX_SEED.maxSpreadBps` of what it would return
 * without it, the ratio the pool itself holds a swap's spread to.
 */
export function phoenixSwapFits(quote: PhoenixSwapQuote): boolean {
  return (
    quote.askAmount >= PHOENIX_SEED.minSwapOut &&
    quote.spreadAmount * BPS <=
      BigInt(PHOENIX_SEED.maxSpreadBps) * (quote.askAmount + quote.spreadAmount)
  );
}

/** The least LWPHX the swap may return: the quote less `PHOENIX_SEED.swapFloorBps`. */
export function phoenixSwapFloor(quote: PhoenixSwapQuote): bigint {
  return (quote.askAmount * (BPS - BigInt(PHOENIX_SEED.swapFloorBps))) / BPS;
}

/**
 * The XLM the deposit offers beside `lwphx`: what the pool's live ratio needs for it, plus
 * `PHOENIX_SEED.depositMarginBps` so the ratio can move a little, and never more than `cap`
 * stroops. The pool takes only what its ratio needs.
 */
export function phoenixDepositXlm(lwphx: bigint, reserves: PhoenixReserves, cap: bigint): bigint {
  if (reserves.reserveA <= BigInt(0) || reserves.reserveB <= BigInt(0)) {
    throw new Error("Phoenix pool: an empty reserve");
  }
  const needed = (lwphx * reserves.reserveB) / reserves.reserveA;
  const offered = (needed * (BPS + BigInt(PHOENIX_SEED.depositMarginBps))) / BPS;
  return offered < cap ? offered : cap;
}

type Simulator = Pick<rpc.Server, "simulateTransaction">;

async function simulateRead(
  server: Simulator,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`Phoenix pool: ${fn} did not simulate`);
  }
  return scValToNative(sim.result.retval);
}

/** The pinned pool's reads on testnet, by simulation. */
export function phoenixReads(
  server: Simulator = new rpc.Server(SOROBAN_RPC_TESTNET_URL)
): PhoenixReads {
  return {
    swapQuote: async (offerStroops) =>
      phoenixSwapQuoteFrom(
        await simulateRead(
          server,
          PHOENIX.pool,
          "simulate_swap",
          new Address(PHOENIX.tokenB).toScVal(),
          nativeToScVal(offerStroops, { type: "i128" })
        )
      ),
    reserves: async () =>
      phoenixReservesFrom(await simulateRead(server, PHOENIX.pool, "query_pool_info")),
    balance: async (token, account) =>
      int(await simulateRead(server, token, "balance", new Address(account).toScVal()), "balance"),
  };
}
