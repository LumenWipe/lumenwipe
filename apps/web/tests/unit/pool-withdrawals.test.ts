import { expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { poolWithdrawalOutcomes } from "@/lib/plan/pool-withdrawals";
import { describeOperation } from "@/lib/stellar/intent/describe";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { stepsCoveredBy } from "@/lib/stellar/covered-steps";
import { operationThresholdCategory } from "@/lib/stellar/thresholds";

const SRC = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const POOL = {
  assetA: "native",
  assetB: USDC,
  fee: 30,
  reserveA: "10000000000",
  reserveB: "5000000000",
  totalShares: "7000000000",
};

test("the analyze screen lists each pool with its shares and the least of each side", () => {
  expect(
    poolWithdrawalOutcomes([{ poolId: "ab".repeat(32), balance: "70.0000000", pool: POOL }], SRC)
  ).toEqual([
    {
      poolId: "ab".repeat(32),
      pair: "XLM/USDC",
      shares: "70.0000000",
      sides: [
        { code: "XLM", minimum: "99", retired: false },
        { code: "USDC", minimum: "49.5", retired: false },
      ],
    },
  ]);
});

test("a side the account issues is shown as retired, and an unread pool is not listed", () => {
  const own = { ...POOL, assetB: `OWN:${SRC}` };
  const [outcome] = poolWithdrawalOutcomes(
    [
      { poolId: "ab".repeat(32), balance: "70.0000000", pool: own },
      { poolId: "cd".repeat(32), balance: "1.0000000", pool: null },
    ],
    SRC
  );
  expect(outcome?.sides[1]).toEqual({ code: "OWN", minimum: "49.5", retired: true });
  expect(poolWithdrawalOutcomes([], SRC)).toEqual([]);
});

test("a withdrawal round decodes, reads in words, counts as medium and covers its step", () => {
  const line = new LiquidityPoolAsset(
    Asset.native(),
    new Asset("USDC", ISSUER),
    LiquidityPoolFeeV18
  );
  const xdr = new TransactionBuilder(new Account(SRC, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(300)
    .addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: "ab".repeat(32),
        amount: "70",
        minAmountA: "99",
        minAmountB: "49.5",
      })
    )
    .addOperation(Operation.changeTrust({ asset: line, limit: "0" }))
    .build()
    .toXDR();
  const [withdraw, removal] = intentFromXdr(xdr, Networks.TESTNET).operations;
  expect(withdraw).toMatchObject({
    type: "liquidity_pool_withdraw",
    poolId: "ab".repeat(32),
    amount: "70.0000000",
    minAmountA: "99.0000000",
    minAmountB: "49.5000000",
  });
  expect(removal).toMatchObject({
    type: "change_trust",
    pool: { assetA: "native", assetB: USDC, fee: 30 },
  });
  expect(describeOperation(withdraw!, undefined)).toBe(
    `Withdraw 70.0000000 shares from liquidity pool ${"ab".repeat(32)}, receiving at least 99.0000000 of its first asset and 49.5000000 of its second`
  );
  expect(describeOperation(removal!, undefined)).toBe(
    `Remove the XLM/${USDC} pool share trustline`
  );
  expect(operationThresholdCategory(withdraw!)).toBe("med");
  expect(stepsCoveredBy(xdr, Networks.TESTNET, SRC)).toEqual([{ type: "WITHDRAW_POOL_SHARES" }]);
});
