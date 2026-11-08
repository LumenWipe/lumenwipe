import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import { WALLET_CONNECT_ID } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import {
  WalletSignInError,
  isContractAddress,
  messageSigningSupport,
  normalizeSignature,
  signChallenge,
  verifySignedMessage,
  walletNetworkPassphrase,
  type MessageSigner,
} from "@/lib/integrator/wallet-sign-in";

const owner = Keypair.random();
const other = Keypair.random();
const MESSAGE = "LumenWipe API keys sign-in\nAddress: test\nIssued: 0\nNonce: n";
const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function wallet(
  answer: (message: string) => { signedMessage: string; signerAddress?: string }
): MessageSigner & { calls: { message: string; opts: unknown }[] } {
  const calls: { message: string; opts: unknown }[] = [];
  return {
    calls,
    signMessage: async (message, opts) => {
      calls.push({ message, opts });
      return answer(message);
    },
  };
}

describe("messageSigningSupport", () => {
  test("follows what each vetted wallet can sign", () => {
    expect(messageSigningSupport(VARIAL_ID)).toBe("yes");
    expect(messageSigningSupport(XBULL_ID)).toBe("yes");
    expect(messageSigningSupport(HANA_ID)).toBe("yes");
    expect(messageSigningSupport(WALLET_CONNECT_ID)).toBe("depends");
    expect(messageSigningSupport(ALBEDO_ID)).toBe("no");
    expect(messageSigningSupport(RABET_ID)).toBe("no");
    expect(messageSigningSupport("unknown")).toBe("no");
    expect(messageSigningSupport(null)).toBe("no");
  });
});

describe("isContractAddress", () => {
  test("tells a contract account from a regular one", () => {
    expect(isContractAddress(CONTRACT)).toBe(true);
    expect(isContractAddress(owner.publicKey())).toBe(false);
  });
});

describe("normalizeSignature", () => {
  const signature = owner.signMessage(MESSAGE);

  test("accepts base64, base64url and hex, and returns standard base64", () => {
    expect(normalizeSignature(base64(signature))).toBe(base64(signature));
    expect(normalizeSignature(Buffer.from(signature).toString("base64url"))).toBe(
      base64(signature)
    );
    expect(normalizeSignature(hex(signature))).toBe(base64(signature));
    expect(normalizeSignature(hex(signature).toUpperCase())).toBe(base64(signature));
  });

  test("refuses anything that is not 64 bytes", () => {
    expect(normalizeSignature(base64(signature.slice(0, 63)))).toBeNull();
    expect(normalizeSignature("not base64!")).toBeNull();
    expect(normalizeSignature("")).toBeNull();
    expect(normalizeSignature(undefined)).toBeNull();
  });
});

describe("verifySignedMessage", () => {
  test("verifies a SEP-53 signature for its own account only", () => {
    const signature = base64(owner.signMessage(MESSAGE));
    expect(verifySignedMessage(owner.publicKey(), MESSAGE, signature)).toBe(true);
    expect(verifySignedMessage(other.publicKey(), MESSAGE, signature)).toBe(false);
    expect(verifySignedMessage(owner.publicKey(), `${MESSAGE}x`, signature)).toBe(false);
    expect(verifySignedMessage(CONTRACT, MESSAGE, signature)).toBe(false);
  });
});

describe("signChallenge", () => {
  test("returns the wallet's signature once it verifies for the address", async () => {
    const signer = wallet((m) => ({
      signedMessage: hex(owner.signMessage(m)),
      signerAddress: owner.publicKey(),
    }));
    const signature = await signChallenge(signer, VARIAL_ID, owner.publicKey(), MESSAGE, "pass");
    expect(signature).toBe(base64(owner.signMessage(MESSAGE)));
    expect(signer.calls[0].opts).toEqual({ address: owner.publicKey(), networkPassphrase: "pass" });
  });

  test("refuses a wallet that answers for another account", async () => {
    const signer = wallet((m) => ({
      signedMessage: base64(other.signMessage(m)),
      signerAddress: other.publicKey(),
    }));
    const error = await signChallenge(signer, VARIAL_ID, owner.publicKey(), MESSAGE).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(WalletSignInError);
    expect((error as WalletSignInError).reason).toBe("signer_mismatch");
  });

  test("refuses a signature by another key even when the wallet claims the address", async () => {
    const signer = wallet((m) => ({
      signedMessage: base64(other.signMessage(m)),
      signerAddress: owner.publicKey(),
    }));
    const error = await signChallenge(signer, HANA_ID, owner.publicKey(), MESSAGE).catch(
      (e: unknown) => e
    );
    expect((error as WalletSignInError).reason).toBe("bad_signature");
  });

  test("refuses a contract account and a wallet that cannot sign, without asking it", async () => {
    const signer = wallet(() => ({ signedMessage: "" }));
    const contract = await signChallenge(signer, VARIAL_ID, CONTRACT, MESSAGE).catch(
      (e: unknown) => e
    );
    expect((contract as WalletSignInError).reason).toBe("contract_account");
    const albedo = await signChallenge(signer, ALBEDO_ID, owner.publicKey(), MESSAGE).catch(
      (e: unknown) => e
    );
    expect((albedo as WalletSignInError).reason).toBe("unsupported_wallet");
    expect((albedo as WalletSignInError).walletId).toBe(ALBEDO_ID);
    expect(signer.calls).toHaveLength(0);
  });
});

describe("walletNetworkPassphrase", () => {
  test("uses the wallet's own network when it reports one", async () => {
    expect(
      await walletNetworkPassphrase({ getNetwork: async () => ({ networkPassphrase: "p" }) })
    ).toBe("p");
  });

  test("is undefined when the wallet cannot say or does not answer in time", async () => {
    expect(
      await walletNetworkPassphrase({ getNetwork: () => Promise.reject(new Error("no")) })
    ).toBeUndefined();
    expect(
      await walletNetworkPassphrase({ getNetwork: () => new Promise(() => {}) }, 10)
    ).toBeUndefined();
  });
});
