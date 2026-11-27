import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { C_ADDRESS, G_ADDRESS, W_ADDRESS, tampered } from "./fixtures/contract-addresses";
import { GAddressPipe } from "@/common/pipes/g-address.pipe";
import { requireGAddress } from "@/common/require-g-address";
import {
  UNSUPPORTED_ADDRESS_MESSAGES,
  isValidGAddress,
  unsupportedAddressKind,
} from "@/lib/utils/validation";

const M_ADDRESS = "MA7QYNF7SOWQ3GLR2BGMZEHXR7CPLRNHIHA6DKPQ7GFPQZS7YJLCBIZD";
const SECRET = Keypair.random().secret();

function refusal(run: () => unknown): { status: number; error: Record<string, unknown> } {
  try {
    run();
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        error: (e.getResponse() as { error: Record<string, unknown> }).error,
      };
    }
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("unsupportedAddressKind", () => {
  test("names a valid contract address", () => {
    expect(unsupportedAddressKind(C_ADDRESS)).toBe("contract");
  });

  test("names a valid muxed contract address", () => {
    expect(unsupportedAddressKind(W_ADDRESS)).toBe("muxed_contract");
  });

  test("is null for an account, a muxed account, a secret seed and anything that is not a strkey", () => {
    for (const value of [
      G_ADDRESS,
      M_ADDRESS,
      SECRET,
      "",
      "nope",
      tampered(C_ADDRESS),
      tampered(W_ADDRESS),
      C_ADDRESS.toLowerCase(),
      ` ${C_ADDRESS}`,
      `${W_ADDRESS}\n`,
      "C" + "A".repeat(10),
      42,
      null,
      undefined,
      {},
    ]) {
      expect(unsupportedAddressKind(value)).toBeNull();
    }
  });

  test("neither kind is an account address", () => {
    expect(isValidGAddress(C_ADDRESS)).toBe(false);
    expect(isValidGAddress(W_ADDRESS)).toBe(false);
  });
});

describe("requireGAddress", () => {
  const call = (value: unknown) =>
    refusal(() => requireGAddress(value, "invalid_source", "A valid source account (G...)."));

  test("returns for a valid account", () => {
    expect(() => requireGAddress(G_ADDRESS, "invalid_source", "x")).not.toThrow();
  });

  test("answers a contract address with unsupported_address_type and its kind", () => {
    expect(call(C_ADDRESS)).toEqual({
      status: 400,
      error: {
        code: "unsupported_address_type",
        message: UNSUPPORTED_ADDRESS_MESSAGES.contract,
        details: { addressType: "contract" },
      },
    });
  });

  test("answers a muxed contract address with unsupported_address_type and its kind", () => {
    expect(call(W_ADDRESS)).toEqual({
      status: 400,
      error: {
        code: "unsupported_address_type",
        message: UNSUPPORTED_ADDRESS_MESSAGES.muxed_contract,
        details: { addressType: "muxed_contract" },
      },
    });
  });

  test("keeps the caller's own code and message for anything that is not a valid strkey", () => {
    for (const value of [
      undefined,
      7,
      "",
      "nope",
      tampered(C_ADDRESS),
      tampered(W_ADDRESS),
      SECRET,
      M_ADDRESS,
    ]) {
      expect(call(value)).toEqual({
        status: 400,
        error: { code: "invalid_source", message: "A valid source account (G...)." },
      });
    }
  });

  test("the messages name the kind and the limit, and never quote an address", () => {
    expect(UNSUPPORTED_ADDRESS_MESSAGES.contract).toContain("contract address (C...)");
    expect(UNSUPPORTED_ADDRESS_MESSAGES.muxed_contract).toContain("muxed contract address (W...)");
    for (const message of Object.values(UNSUPPORTED_ADDRESS_MESSAGES)) {
      expect(message).toContain("Closing and analysing contract accounts is not supported yet.");
      expect(message).not.toContain(C_ADDRESS);
      expect(message).not.toContain(W_ADDRESS);
    }
    for (const value of [C_ADDRESS, W_ADDRESS]) {
      expect(JSON.stringify(call(value))).not.toContain(value);
    }
  });
});

describe("GAddressPipe", () => {
  const pipe = new GAddressPipe("invalid_address", "Invalid Stellar address");

  test("answers C and W with the new code, whatever code the route configured", () => {
    expect(refusal(() => pipe.transform(C_ADDRESS)).error.code).toBe("unsupported_address_type");
    expect(refusal(() => pipe.transform(W_ADDRESS)).error.code).toBe("unsupported_address_type");
  });

  test("keeps invalid_address for a value that is not a valid strkey", () => {
    expect(refusal(() => pipe.transform(tampered(W_ADDRESS))).error).toEqual({
      code: "invalid_address",
      message: "Invalid Stellar address",
    });
  });
});
