import { expect, spyOn, test } from "bun:test";
import { SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import { sampleTransaction } from "../support/rpc-fixtures";

// The transaction builders read simulation fields with no fallback for the node's wire shape:
// these pin that `rpc.Server.simulateTransaction`, as getRpcServer serves it, always parses.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SimulateReturnsParsed = Assert<
  Equal<Awaited<ReturnType<rpc.Server["simulateTransaction"]>>, rpc.Api.SimulateTransactionResponse>
>;

const wire = { id: "1", latestLedger: 1, events: [] };

test("a successful simulation reaches callers parsed, with its return value decoded", async () => {
  const transport = spyOn(rpc.Server.prototype, "_simulateTransaction").mockResolvedValue({
    ...wire,
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().build().toXDR("base64"),
    results: [{ auth: [], xdr: nativeToScVal(7n, { type: "i128" }).toXDR("base64") }],
  });
  try {
    const simulation = await getRpcServer("testnet").simulateTransaction(sampleTransaction());
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rpc.Api.isSimulationRaw(simulation)).toBe(false);
    expect(rpc.Api.isSimulationSuccess(simulation)).toBe(true);
    const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    expect(retval).toBeInstanceOf(xdr.ScVal);
    expect(scValToNative(retval!)).toBe(7n);
  } finally {
    transport.mockRestore();
  }
});

test("a failed simulation reaches callers parsed as an error", async () => {
  const transport = spyOn(rpc.Server.prototype, "_simulateTransaction").mockResolvedValue({
    ...wire,
    error: "HostError: Error(Contract, #1)",
  });
  try {
    const simulation = await getRpcServer("testnet").simulateTransaction(sampleTransaction());
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rpc.Api.isSimulationRaw(simulation)).toBe(false);
    expect(rpc.Api.isSimulationError(simulation)).toBe(true);
  } finally {
    transport.mockRestore();
  }
});
