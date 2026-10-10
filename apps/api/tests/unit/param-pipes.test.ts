import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { NetworkPipe } from "@/common/pipes/network.pipe";
import { GAddressPipe } from "@/common/pipes/g-address.pipe";

const ADDRESS = Keypair.random().publicKey();

function thrown(run: () => unknown): { status: number; error: { code: string; message: string } } {
  try {
    run();
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        error: (e.getResponse() as { error: { code: string; message: string } }).error,
      };
    }
    throw e;
  }
  throw new Error("expected the pipe to throw");
}

describe("NetworkPipe", () => {
  test("passes both supported networks through", () => {
    expect(new NetworkPipe().transform("testnet")).toBe("testnet");
    expect(new NetworkPipe().transform("mainnet")).toBe("mainnet");
  });

  test("rejects anything else with a 400 invalid_network and the default message", () => {
    for (const value of ["betanet", "", "TESTNET", "public"]) {
      expect(thrown(() => new NetworkPipe().transform(value))).toEqual({
        status: 400,
        error: { code: "invalid_network", message: "Invalid network." },
      });
    }
  });

  test("keeps the message variant a controller was already using", () => {
    expect(thrown(() => new NetworkPipe("Invalid network").transform("x")).error.message).toBe(
      "Invalid network"
    );
  });
});

describe("GAddressPipe", () => {
  const pipe = new GAddressPipe("invalid_address", "Invalid Stellar address");

  test("returns a valid G address unchanged", () => {
    expect(pipe.transform(ADDRESS)).toBe(ADDRESS);
  });

  test("rejects a malformed address with the configured code and message", () => {
    expect(thrown(() => pipe.transform("x"))).toEqual({
      status: 400,
      error: { code: "invalid_address", message: "Invalid Stellar address" },
    });
  });

  test("a muxed address is not a G address", () => {
    expect(thrown(() => pipe.transform(`M${ADDRESS.slice(1)}`)).error.code).toBe("invalid_address");
  });
});
