import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";
import { apiErrorMessage } from "@/lib/api/error-body";
import { VerificationError } from "@/lib/stellar/verify";
import { TxSubmitError } from "@/lib/utils/errors";
import {
  ApiRequestError,
  toUserMessage,
  UserFacingError,
  type ErrorContext,
} from "@/lib/utils/user-error";

const LEAKS = /\b(tx|op)_[a-z_]+\b|Error:|\bat \S+ \(|undefined|\[object|stack|\(\d{3}\)/i;

let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("toUserMessage", () => {
  test("a wallet rejection becomes a calm, actionable message", () => {
    const msg = toUserMessage(new Error("User declined access"), "execute");
    expect(msg).toMatch(/declined the request in your wallet/);
    expect(msg).not.toMatch(/User declined access/);
  });

  test("a wallet error thrown as a plain object is still recognized", () => {
    expect(
      toUserMessage({ code: -4, message: "The user rejected this request." }, "wallet")
    ).toMatch(/declined/);
  });

  test("wallet timeouts and locked wallets are mapped", () => {
    expect(toUserMessage(new Error("Request timed out"), "execute")).toMatch(/didn't respond/);
    expect(toUserMessage(new Error("Wallet is locked"), "wallet")).toMatch(/locked/);
  });

  test("wallet wording is not interpreted outside signing contexts", () => {
    expect(toUserMessage(new Error("user rejected"), "analyze")).toBe(
      toUserMessage(new Error("anything else"), "analyze")
    );
  });

  test("a verification failure never leaks its technical detail", () => {
    const msg = toUserMessage(
      new VerificationError("op 2 pays GABC to unexpected dest"),
      "execute"
    );
    expect(msg).toMatch(/doesn't match what you approved/);
    expect(msg).not.toMatch(/GABC|op 2/);
  });

  test("API status codes map to plain copy", () => {
    expect(toUserMessage(new ApiRequestError(429, ""), "execute")).toMatch(/Too many requests/);
    expect(toUserMessage(new ApiRequestError(502, "Bad Gateway"), "execute")).toMatch(
      /temporarily unavailable/
    );
    expect(toUserMessage(new LumenWipeApiError(503, {}), "analyze")).toMatch(/temporarily/);
    expect(toUserMessage(new LumenWipeTimeoutError(30000), "execute")).toMatch(/temporarily/);
  });

  test("a plain 422 message from the API is kept, a code-shaped one is not", () => {
    expect(toUserMessage(new ApiRequestError(422, "Choose a destination first."), "review")).toBe(
      "Choose a destination first."
    );
    expect(
      toUserMessage(new ApiRequestError(422, "simulation failed: op_underfunded"), "review")
    ).not.toMatch(LEAKS);
  });

  test("merge pre-flight refusals keep their plain explanation and a failed read stays retryable", () => {
    const sequence =
      "This account's sequence number is too far ahead for the network to merge it. Retrying does not help: it can be closed only once the network's ledger count catches up.";
    const missing =
      "The destination account does not exist on testnet. A close never creates it: fund the destination first, or choose a different account.";
    expect(toUserMessage(new ApiRequestError(422, sequence), "review")).toBe(sequence);
    expect(toUserMessage(new ApiRequestError(422, missing), "review")).toBe(missing);
    expect(
      toUserMessage(new ApiRequestError(503, "The destination could not be read."), "review")
    ).toMatch(/temporarily unavailable/);
  });

  test("a failed fetch is reported as a connection problem", () => {
    expect(toUserMessage(new TypeError("Failed to fetch"), "execute")).toMatch(
      /check your connection/
    );
  });

  test("authored messages pass through unchanged", () => {
    expect(toUserMessage(new UserFacingError("Reconnect your wallet."))).toBe(
      "Reconnect your wallet."
    );
    expect(
      toUserMessage(
        new TxSubmitError("The network fee was too low. Please retry.", "tx_insufficient_fee")
      )
    ).toBe("The network fee was too low. Please retry.");
  });

  const contexts: ErrorContext[] = ["analyze", "review", "execute", "wallet", "generic"];
  const unexpected: unknown[] = [
    new Error("HostFunctionError: simulation failed at wasm_trap (host.rs:42)"),
    new Error("tx_bad_seq"),
    "RPC_ERROR_-32602",
    { code: 1234 },
    null,
    undefined,
    42,
  ];
  test.each(contexts)("%s: unmapped errors collapse to the fallback and are logged", (context) => {
    for (const err of unexpected) {
      const msg = toUserMessage(err, context);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(LEAKS);
      expect(msg).not.toMatch(/wasm|HostFunction|RPC_ERROR|1234/);
    }
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("apiErrorMessage", () => {
  test("keeps a plain message", () => {
    expect(apiErrorMessage({ error: { message: "Account not found." } }, "x")).toBe(
      "Account not found."
    );
  });

  test.each([
    { error: { message: "op_no_trust" } },
    { error: "Error: boom at fn (a.ts:1:2)" },
    { message: "Request failed (502)" },
    { error: { message: "x".repeat(300) } },
  ])("falls back for non-plain bodies %#", (body) => {
    expect(apiErrorMessage(body, "fallback")).toBe("fallback");
  });
});
