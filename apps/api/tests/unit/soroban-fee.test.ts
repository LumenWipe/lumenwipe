import { describe, expect, test } from "bun:test";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  type rpc,
} from "@stellar/stellar-sdk";
import {
  BASE_FEE_STROOPS,
  MAX_SOROBAN_EXIT_FEE_STROOPS,
  MAX_SOROBAN_INCLUSION_FEE_STROOPS,
  SOROBAN_EXIT_FEE_ESTIMATE_STROOPS,
  SOROBAN_FEE_STATS_TTL_MS,
} from "@/config/constants";
import {
  SorobanFeeSurgeError,
  sorobanInclusionFee,
  withInclusionFee,
  type FeeStatsRpc,
} from "@/lib/stellar/soroban-fee";
import { feeStats } from "../support/rpc-fixtures";

const CAP = BigInt(MAX_SOROBAN_INCLUSION_FEE_STROOPS);

function statsRpc(answer: () => Promise<rpc.Api.GetFeeStatsResponse>): FeeStatsRpc & {
  calls: number;
} {
  const server = {
    calls: 0,
    getFeeStats: async () => {
      server.calls++;
      return answer();
    },
  };
  return server;
}

const at = (fee: string) => statsRpc(async () => feeStats(fee));

describe("the Soroban inclusion fee", () => {
  test("is twice the 90th percentile of the network's recent inclusion fees", async () => {
    expect(await sorobanInclusionFee(at("200"))).toBe(400n);
  });

  test("never bids below the base fee", async () => {
    expect(await sorobanInclusionFee(at("0"))).toBe(BigInt(BASE_FEE_STROOPS));
    expect(await sorobanInclusionFee(at("40"))).toBe(BigInt(BASE_FEE_STROOPS));
  });

  test("bids up to the cap and refuses above it", async () => {
    expect(await sorobanInclusionFee(at(String(CAP / 2n)))).toBe(CAP);
    const surge = sorobanInclusionFee(at(String(CAP / 2n + 1n)));
    await expect(surge).rejects.toBeInstanceOf(SorobanFeeSurgeError);
    await expect(surge).rejects.toThrow(/nothing was built/);
  });

  test("bids the cap when the stats cannot be read", async () => {
    expect(await sorobanInclusionFee(statsRpc(() => Promise.reject(new Error("down"))))).toBe(CAP);
    const malformed = { ...feeStats(), sorobanInclusionFee: { ...feeStats().sorobanInclusionFee } };
    malformed.sorobanInclusionFee.p90 = "2e3";
    expect(await sorobanInclusionFee(statsRpc(async () => malformed))).toBe(CAP);
    expect(await sorobanInclusionFee(statsRpc(async () => JSON.parse("{}")))).toBe(CAP);
  });

  test("reads the stats once per ledger for every concurrent and later build", async () => {
    let now = 1_000;
    const server = at("200");
    const fees: bigint[] = await Promise.all([
      sorobanInclusionFee(server, () => now),
      sorobanInclusionFee(server, () => now),
    ]);
    now += SOROBAN_FEE_STATS_TTL_MS - 1;
    fees.push(await sorobanInclusionFee(server, () => now));
    expect(fees).toEqual([400n, 400n, 400n]);
    expect(server.calls).toBe(1);
    now += 1;
    await sorobanInclusionFee(server, () => now);
    expect(server.calls).toBe(2);
  });

  test("does not keep a failed read: the next build asks again", async () => {
    let fail = true;
    const server = statsRpc(async () => {
      if (fail) throw new Error("down");
      return feeStats("200");
    });
    expect(await sorobanInclusionFee(server, () => 0)).toBe(CAP);
    fail = false;
    expect(await sorobanInclusionFee(server, () => 0)).toBe(400n);
    expect(server.calls).toBe(2);
  });

  test("at the cap, still fits the plan's per-transaction bound and every envelope fee cap", () => {
    const realExitResourceFee = 25_000n;
    expect(CAP + realExitResourceFee).toBeLessThanOrEqual(
      BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS)
    );
    expect(CAP + BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS)).toBeLessThan(
      BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)
    );
  });
});

describe("withInclusionFee", () => {
  const contract = new Contract("CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE");
  const SOURCE = Keypair.random().publicKey();
  const soroban = (fee: string) =>
    new TransactionBuilder(new Account(SOURCE, "7"), {
      fee,
      networkPassphrase: Networks.PUBLIC,
      sorobanData: new SorobanDataBuilder().setResourceFee(30_000n).build(),
    })
      .addOperation(contract.call("swap"))
      .setTimeout(300)
      .build();

  test("replaces only the inclusion part of the fee", () => {
    const original = soroban("100");
    const repriced = withInclusionFee(original, 400n);
    expect(repriced.fee).toBe("30400");
    expect(withInclusionFee(repriced, 100n).toXDR()).toBe(original.toXDR());
  });

  test("refuses a classic transaction", () => {
    const classic = new TransactionBuilder(new Account(SOURCE, "7"), {
      fee: "100",
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(contract.call("swap"))
      .setTimeout(300)
      .build();
    expect(() => withInclusionFee(classic, 400n)).toThrow(/not a Soroban transaction/);
  });
});
